use std::f64::consts::{LN_2, LN_10, SQRT_2};

const MIN_RE: f64 = 4000.0;
const MAX_RE: f64 = 1e8;
const TOLERANCE: f64 = 1e-12;

#[inline]
fn log(x: f64) -> f64 {
    // Clamond only calls this with positive normal arguments.
    let bits = x.to_bits();
    let mut exponent = ((bits >> 52) as i32 - 1023) as f64;
    let mut mantissa = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    if mantissa > SQRT_2 {
        mantissa *= 0.5;
        exponent += 1.0;
    }
    let y = (mantissa - 1.0) / (mantissa + 1.0);
    let y2 = y * y;
    let mut term = 1.0 / 15.0;
    for denominator in [13.0, 11.0, 9.0, 7.0, 5.0, 3.0, 1.0] {
        term = 1.0 / denominator + y2 * term;
    }
    2.0 * y * term + exponent * LN_2
}

pub fn valid_regime(flow: f64, area: f64, diameter: f64, viscosity: f64) -> Result<(), u32> {
    let velocity = flow / area;
    let reynolds = velocity.abs() * diameter / viscosity;
    if (2000.0..MIN_RE).contains(&reynolds) {
        return Err(3);
    }
    if velocity <= 0.0 || !(MIN_RE..=MAX_RE).contains(&reynolds) {
        return Err(2);
    }
    Ok(())
}

fn residual(inverse_root: f64, roughness_term: f64, reynolds_term: f64) -> f64 {
    inverse_root + 2.0 * (roughness_term + reynolds_term * inverse_root).log10()
}

fn safeguarded_factor(reynolds: f64, roughness: f64) -> Result<f64, u32> {
    let roughness_term = roughness / 3.7;
    let reynolds_term = 2.51 / reynolds;
    let (mut low, mut high) = (1.0, 100.0);
    if residual(low, roughness_term, reynolds_term) > 0.0
        || residual(high, roughness_term, reynolds_term) < 0.0
    {
        return Err(2);
    }
    let mut current = (low + high) / 2.0;
    for _ in 0..100 {
        let term = roughness_term + reynolds_term * current;
        let difference = residual(current, roughness_term, reynolds_term);
        if difference.abs() <= TOLERANCE {
            return Ok(current.powi(-2));
        }
        if difference > 0.0 {
            high = current;
        } else {
            low = current;
        }
        let next = current - difference / (1.0 + 2.0 * reynolds_term / (LN_10 * term));
        current = if low < next && next < high {
            next
        } else {
            (low + high) / 2.0
        };
    }
    Err(2)
}

#[derive(Clone, Copy)]
pub struct Friction {
    pub area: f64,
    pub diameter: f64,
    pub roughness: f64,
    pub seconds: f64,
}

impl Friction {
    #[inline]
    fn checked_acceleration(
        &self,
        velocity: f64,
        reynolds: f64,
        inverse_root: f64,
    ) -> Result<f64, u32> {
        let candidate = 1.0 / inverse_root;
        let residual = residual(inverse_root, self.roughness / 3.7, 2.51 / reynolds);
        let factor = if candidate.is_finite() && candidate > 0.0 && residual.abs() <= TOLERANCE {
            candidate * candidate
        } else {
            safeguarded_factor(reynolds, self.roughness)?
        };
        if self.seconds * 2.0 * factor * velocity / self.diameter > 0.1 {
            return Err(2);
        }
        Ok(factor * velocity * velocity / (2.0 * self.diameter))
    }

    #[inline]
    pub fn one(&self, flow: f64, viscosity: f64) -> Result<f64, u32> {
        valid_regime(flow, self.area, self.diameter, viscosity)?;
        let velocity = flow / self.area;
        let reynolds = velocity * self.diameter / viscosity;
        let x1 = LN_10 * self.roughness * reynolds / 18.574;
        let x2 = log(LN_10 * reynolds / 5.02);
        let mut z = x2 - 0.2;
        for _ in 0..2 {
            let sum = x1 + z;
            let e = (z + log(sum) - x2) / (1.0 + sum);
            z -= ((1.0 + sum + e / 2.0) * e * sum) / (1.0 + sum + e + e * e / 3.0);
        }
        self.checked_acceleration(velocity, reynolds, 2.0 * z / LN_10)
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod packed {
    use super::*;
    use std::arch::wasm32::*;

    #[inline]
    fn log_lanes(x: v128) -> v128 {
        let unbiased = i64x2_sub(u64x2_shr(x, 52), i64x2_splat(1023));
        let exponent = f64x2_convert_low_i32x4(i32x4_shuffle::<0, 2, 0, 2>(unbiased, unbiased));
        let mantissa = v128_or(
            v128_and(x, i64x2_splat(0x000f_ffff_ffff_ffff)),
            i64x2_splat(0x3ff0_0000_0000_0000),
        );
        let shift = f64x2_gt(mantissa, f64x2_splat(SQRT_2));
        let one = f64x2_splat(1.0);
        let mantissa = v128_bitselect(f64x2_mul(mantissa, f64x2_splat(0.5)), mantissa, shift);
        let exponent = f64x2_add(exponent, v128_and(one, shift));
        let y = f64x2_div(f64x2_sub(mantissa, one), f64x2_add(mantissa, one));
        let y2 = f64x2_mul(y, y);
        let mut term = f64x2_splat(1.0 / 15.0);
        for denominator in [13.0, 11.0, 9.0, 7.0, 5.0, 3.0, 1.0] {
            term = f64x2_add(f64x2_splat(1.0 / denominator), f64x2_mul(y2, term));
        }
        f64x2_add(
            f64x2_mul(f64x2_mul(f64x2_splat(2.0), y), term),
            f64x2_mul(exponent, f64x2_splat(LN_2)),
        )
    }

    impl Friction {
        #[inline]
        pub fn two(&self, flow: v128, viscosity: v128) -> Result<v128, u32> {
            let velocity = f64x2_div(flow, f64x2_splat(self.area));
            let reynolds = f64x2_div(f64x2_mul(velocity, f64x2_splat(self.diameter)), viscosity);
            let re0 = f64x2_extract_lane::<0>(reynolds);
            let re1 = f64x2_extract_lane::<1>(reynolds);
            if !(MIN_RE..=MAX_RE).contains(&re0) || !(MIN_RE..=MAX_RE).contains(&re1) {
                return Ok(f64x2(
                    self.one(
                        f64x2_extract_lane::<0>(flow),
                        f64x2_extract_lane::<0>(viscosity),
                    )?,
                    self.one(
                        f64x2_extract_lane::<1>(flow),
                        f64x2_extract_lane::<1>(viscosity),
                    )?,
                ));
            }
            let x1 = f64x2_div(
                f64x2_mul(f64x2_splat(LN_10 * self.roughness), reynolds),
                f64x2_splat(18.574),
            );
            let x2 = log_lanes(f64x2_div(
                f64x2_mul(f64x2_splat(LN_10), reynolds),
                f64x2_splat(5.02),
            ));
            let one = f64x2_splat(1.0);
            let two = f64x2_splat(2.0);
            let mut z = f64x2_sub(x2, f64x2_splat(0.2));
            for _ in 0..2 {
                let sum = f64x2_add(x1, z);
                let denominator = f64x2_add(one, sum);
                let e = f64x2_div(f64x2_sub(f64x2_add(z, log_lanes(sum)), x2), denominator);
                let numerator =
                    f64x2_mul(f64x2_mul(f64x2_add(denominator, f64x2_div(e, two)), e), sum);
                let correction = f64x2_div(
                    numerator,
                    f64x2_add(
                        f64x2_add(denominator, e),
                        f64x2_div(f64x2_mul(e, e), f64x2_splat(3.0)),
                    ),
                );
                z = f64x2_sub(z, correction);
            }
            let inverse_root = f64x2_div(f64x2_mul(two, z), f64x2_splat(LN_10));
            Ok(f64x2(
                self.checked_acceleration(
                    f64x2_extract_lane::<0>(velocity),
                    re0,
                    f64x2_extract_lane::<0>(inverse_root),
                )?,
                self.checked_acceleration(
                    f64x2_extract_lane::<1>(velocity),
                    re1,
                    f64x2_extract_lane::<1>(inverse_root),
                )?,
            ))
        }
    }
}
