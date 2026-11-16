use std::cell::RefCell;

mod friction;
mod hydraulics;

use friction::Friction;
use hydraulics::{Cache, Fields, Step};

const MAX_NODES: usize = 401;
const INPUT_WORDS: usize = 4 * MAX_NODES;
const WORKSPACE_WORDS: usize = 7 * MAX_NODES + 1;

struct Workspace {
    words: [f64; WORKSPACE_WORDS],
    cache: Cache,
}

thread_local! {
    // One instance serves one worker and never grows its numerical workspace.
    static WORKSPACE: RefCell<Workspace> = RefCell::new(Workspace {
        words: [0.0; WORKSPACE_WORDS], cache: Cache::new(),
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_version() -> u32 {
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_variant() -> u32 {
    if cfg!(all(target_arch = "wasm32", target_feature = "simd128")) {
        2
    } else {
        1
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn workspace_words() -> u32 {
    WORKSPACE_WORDS as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn workspace_ptr() -> *mut f64 {
    WORKSPACE.with_borrow_mut(|workspace| workspace.words.as_mut_ptr())
}

/// The caller writes three nodal fields and one cell field into fixed slots
/// before invoking this function. Output fields are in separate fixed slots.
#[unsafe(no_mangle)]
pub extern "C" fn step_si(
    nodes: u32,
    courant: f64,
    seconds: f64,
    wave_speed: f64,
    density: f64,
    impedance: f64,
    area: f64,
    diameter: f64,
    roughness: f64,
    pin: f64,
    qout: f64,
    leak_node: u32,
    opening: f64,
    external_pressure: f64,
    pressure_min: f64,
    pressure_max: f64,
    reference_flow: f64,
) -> u32 {
    let nodes = nodes as usize;
    let leak_node = leak_node as usize;
    if !(3..=MAX_NODES).contains(&nodes)
        || !(0.0 < courant && courant <= 1.0)
        || !(0.0..=0.05).contains(&roughness)
        || !(0.0..=4e-5).contains(&opening)
        || (opening > 0.0 && !(1..nodes - 1).contains(&leak_node))
        || !external_pressure.is_finite()
        || external_pressure >= pressure_min
        || !(pressure_min..=pressure_max).contains(&pin)
        || ![
            seconds,
            wave_speed,
            density,
            impedance,
            area,
            diameter,
            reference_flow,
            pressure_min,
            pressure_max,
        ]
        .into_iter()
        .all(|value| value.is_finite() && value > 0.0)
        || !qout.is_finite()
    {
        return 1;
    }
    let source = density * wave_speed * seconds;
    if !source.is_finite() {
        return 1;
    }
    let step = Step {
        courant,
        density,
        impedance,
        source,
        pin,
        qout,
        leak_node,
        opening,
        external_pressure,
        pressure_min,
        pressure_max,
        reference_flow,
        friction: Friction {
            area,
            diameter,
            roughness,
            seconds,
        },
    };
    WORKSPACE.with_borrow_mut(|workspace| {
        let (input, output) = workspace.words.split_at_mut(INPUT_WORDS);
        let old = Fields {
            p: &input[..nodes],
            left: &input[MAX_NODES..MAX_NODES + nodes],
            right: &input[2 * MAX_NODES..2 * MAX_NODES + nodes],
            viscosity: &input[3 * MAX_NODES..3 * MAX_NODES + nodes - 1],
        };
        if !old
            .p
            .iter()
            .all(|p| (pressure_min..=pressure_max).contains(p))
            || !old
                .left
                .iter()
                .chain(old.right)
                .all(|value| value.is_finite())
            || !old
                .viscosity
                .iter()
                .all(|&value| value.is_finite() && value > 0.0)
        {
            return 1;
        }
        let (p, rest) = output.split_at_mut(MAX_NODES);
        let (left, rest) = rest.split_at_mut(MAX_NODES);
        let (right, scalar) = rest.split_at_mut(MAX_NODES);
        let next = Fields {
            p: &mut p[..nodes],
            left: &mut left[..nodes],
            right: &mut right[..nodes],
            viscosity: old.viscosity,
        };
        match hydraulics::advance(step, old, next, &mut workspace.cache) {
            Ok(leak) => {
                scalar[0] = leak;
                0
            }
            Err(code) => code,
        }
    })
}
