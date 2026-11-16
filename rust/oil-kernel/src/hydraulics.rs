use crate::friction::{Friction, valid_regime};

#[derive(Clone, Copy)]
pub struct Fields<'a, T> {
    pub p: T,
    pub left: T,
    pub right: T,
    pub viscosity: &'a [f64],
}

#[derive(Clone, Copy)]
pub struct Step {
    pub courant: f64,
    pub density: f64,
    pub impedance: f64,
    pub source: f64,
    pub pin: f64,
    pub qout: f64,
    pub leak_node: usize,
    pub opening: f64,
    pub external_pressure: f64,
    pub pressure_min: f64,
    pub pressure_max: f64,
    pub reference_flow: f64,
    pub friction: Friction,
}

#[inline]
fn interpolate(center: f64, neighbor: f64, fraction: f64) -> f64 {
    if fraction == 1.0 {
        neighbor
    } else {
        center + fraction * (neighbor - center)
    }
}

type Input<'a> = Fields<'a, &'a [f64]>;
type Output<'a> = Fields<'a, &'a mut [f64]>;

pub struct Cache {
    left: [f64; crate::MAX_NODES],
    right: [f64; crate::MAX_NODES],
}

impl Cache {
    pub fn new() -> Self {
        Self {
            left: [0.0; crate::MAX_NODES],
            right: [0.0; crate::MAX_NODES],
        }
    }

    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    fn fill_left(&mut self, flows: &[f64], friction: Friction, viscosity: f64) -> Result<(), u32> {
        use std::arch::wasm32::*;
        let (pairs, remainder) = flows.as_chunks::<2>();
        for (index, flows) in pairs.iter().enumerate() {
            let values = friction.two(f64x2(flows[0], flows[1]), f64x2_splat(viscosity))?;
            self.left[2 * index] = f64x2_extract_lane::<0>(values);
            self.left[2 * index + 1] = f64x2_extract_lane::<1>(values);
        }
        if let Some(&last) = remainder.first() {
            self.left[flows.len() - 1] = friction.one(last, viscosity)?;
        }
        Ok(())
    }

    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    fn fill_left(&mut self, flows: &[f64], friction: Friction, viscosity: f64) -> Result<(), u32> {
        for (index, &flow) in flows.iter().enumerate() {
            self.left[index] = friction.one(flow, viscosity)?;
        }
        Ok(())
    }

    fn fill(&mut self, old: Input, friction: Friction, viscosity: f64) -> Result<(), u32> {
        self.fill_left(old.left, friction, viscosity)?;
        for index in 0..old.p.len() {
            self.right[index] = if old.left[index] == old.right[index] {
                self.left[index]
            } else {
                friction.one(old.right[index], viscosity)?
            };
        }
        Ok(())
    }
}

#[inline]
fn plus(step: Step, old: Input, i: usize, cache: Option<&Cache>) -> Result<f64, u32> {
    let flow = interpolate(old.left[i], old.right[i - 1], step.courant);
    let friction = match cache {
        Some(cache) => cache.right[i - 1],
        None => step.friction.one(flow, old.viscosity[i - 1])?,
    };
    let pressure = interpolate(old.p[i], old.p[i - 1], step.courant);
    Ok(pressure + (step.impedance * flow - step.source * friction))
}

#[inline]
fn minus(step: Step, old: Input, i: usize, cache: Option<&Cache>) -> Result<f64, u32> {
    let flow = interpolate(old.right[i], old.left[i + 1], step.courant);
    let friction = match cache {
        Some(cache) => cache.left[i + 1],
        None => step.friction.one(flow, old.viscosity[i])?,
    };
    let pressure = interpolate(old.p[i], old.p[i + 1], step.courant);
    Ok(pressure - (step.impedance * flow - step.source * friction))
}

#[inline]
fn ordinary(
    step: Step,
    old: Input,
    next: &mut Output,
    i: usize,
    cache: Option<&Cache>,
) -> Result<(), u32> {
    let plus = plus(step, old, i, cache)?;
    let minus = minus(step, old, i, cache)?;
    let flow = (plus - minus) / (2.0 * step.impedance);
    next.p[i] = (plus + minus) / 2.0;
    next.left[i] = flow;
    next.right[i] = flow;
    Ok(())
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
fn interior(step: Step, old: Input, next: &mut Output, cache: Option<&Cache>) -> Result<(), u32> {
    for i in 1..old.p.len() - 1 {
        ordinary(step, old, next, i, cache)?;
    }
    Ok(())
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
fn interior(step: Step, old: Input, next: &mut Output, cache: Option<&Cache>) -> Result<(), u32> {
    use std::arch::wasm32::*;

    let load = |slice: &[f64], index: usize| f64x2(slice[index], slice[index + 1]);
    let interp = |base, neighbor| {
        if step.courant == 1.0 {
            neighbor
        } else {
            f64x2_add(
                base,
                f64x2_mul(f64x2_splat(step.courant), f64x2_sub(neighbor, base)),
            )
        }
    };
    let impedance = f64x2_splat(step.impedance);
    let source = f64x2_splat(step.source);
    let last = old.p.len() - 1;
    let mut i = 1;
    while i + 1 < last {
        let pressure = load(old.p, i);
        let left = interp(load(old.left, i), load(old.right, i - 1));
        let right = interp(load(old.right, i), load(old.left, i + 1));
        let (left_friction, right_friction) = match cache {
            Some(cache) => (load(&cache.right, i - 1), load(&cache.left, i + 1)),
            None => (
                step.friction.two(left, load(old.viscosity, i - 1))?,
                step.friction.two(right, load(old.viscosity, i))?,
            ),
        };
        let plus = f64x2_add(
            interp(pressure, load(old.p, i - 1)),
            f64x2_sub(f64x2_mul(impedance, left), f64x2_mul(source, left_friction)),
        );
        let minus = f64x2_sub(
            interp(pressure, load(old.p, i + 1)),
            f64x2_sub(
                f64x2_mul(impedance, right),
                f64x2_mul(source, right_friction),
            ),
        );
        let pressure = f64x2_mul(f64x2_add(plus, minus), f64x2_splat(0.5));
        let flow = f64x2_div(f64x2_sub(plus, minus), f64x2_splat(2.0 * step.impedance));
        next.p[i] = f64x2_extract_lane::<0>(pressure);
        next.p[i + 1] = f64x2_extract_lane::<1>(pressure);
        next.left[i] = f64x2_extract_lane::<0>(flow);
        next.left[i + 1] = f64x2_extract_lane::<1>(flow);
        next.right[i] = next.left[i];
        next.right[i + 1] = next.left[i + 1];
        i += 2;
    }
    if i < last {
        ordinary(step, old, next, i, cache)?;
    }
    Ok(())
}

fn junction(step: Step, plus: f64, minus: f64) -> Result<(f64, f64, f64, f64), u32> {
    let at = |pressure| {
        (
            pressure,
            (plus - pressure) / step.impedance,
            (pressure - minus) / step.impedance,
            step.opening * f64::sqrt(2.0 * (pressure - step.external_pressure) / step.density),
        )
    };
    let residual = |(_, left, right, leak)| left - right - leak;
    let (mut low, mut high) = (step.pressure_min, step.pressure_max);
    let tolerance = 1e-10 * step.reference_flow;
    let left = at(low);
    let right = at(high);
    let (left_residual, right_residual) = (residual(left), residual(right));
    if !(left_residual >= 0.0 && right_residual <= 0.0) {
        return Err(2);
    }
    if left_residual <= tolerance {
        return Ok(left);
    }
    if right_residual == 0.0 {
        return Ok(right);
    }
    for _ in 0..80 {
        let middle = at((low + high) / 2.0);
        let mismatch = residual(middle);
        if mismatch >= 0.0 && mismatch <= tolerance {
            return Ok(middle);
        }
        if mismatch > 0.0 {
            low = middle.0;
        } else {
            high = middle.0;
        }
    }
    Err(2)
}

pub fn advance(step: Step, old: Input, mut next: Output, scratch: &mut Cache) -> Result<f64, u32> {
    let last = old.p.len() - 1;
    let uniform = old.viscosity.iter().all(|&nu| nu == old.viscosity[0]);
    let cache = if step.courant == 1.0 && uniform {
        scratch.fill(old, step.friction, old.viscosity[0])?;
        Some(&*scratch)
    } else {
        None
    };
    interior(step, old, &mut next, cache)?;
    next.p[0] = step.pin;
    next.left[0] = (step.pin - minus(step, old, 0, cache)?) / step.impedance;
    next.right[0] = next.left[0];
    next.p[last] = plus(step, old, last, cache)? - step.impedance * step.qout;
    next.left[last] = step.qout;
    next.right[last] = step.qout;

    let mut leak_flow = 0.0;
    if step.opening > 0.0 {
        let i = step.leak_node;
        let (p, left, right, withdrawal) = junction(
            step,
            plus(step, old, i, cache)?,
            minus(step, old, i, cache)?,
        )?;
        next.p[i] = p;
        next.left[i] = left;
        next.right[i] = right;
        leak_flow = withdrawal;
    }
    for i in 0..=last {
        if !(step.pressure_min..=step.pressure_max).contains(&next.p[i]) {
            return Err(2);
        }
        let Friction { area, diameter, .. } = step.friction;
        valid_regime(
            next.left[i],
            area,
            diameter,
            next.viscosity[i.saturating_sub(1)],
        )?;
        valid_regime(
            next.right[i],
            area,
            diameter,
            next.viscosity[i.min(last - 1)],
        )?;
    }
    Ok(leak_flow)
}
