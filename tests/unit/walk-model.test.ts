import { describe, expect, it } from 'vitest'
import { INITIAL_MISSION, INITIAL_POSITION, WALK_TARGETS, equipTool, interact, movePlayer, nearestTarget, objective, targetInReach, type TargetId } from '../../src/walk/model'

const act = (state: typeof INITIAL_MISSION, target: TargetId) => interact(state, target).mission

describe('3D inspection exercise', () => {
  it('picks only reachable targets and starts with the scanner in reach', () => {
    expect(nearestTarget(INITIAL_POSITION, INITIAL_MISSION)?.id).toBe('scanner')
    expect(nearestTarget(INITIAL_POSITION, act(INITIAL_MISSION, 'scanner'))).toBeNull()
    expect(nearestTarget({ x: 4.8, z: 4.1 }, INITIAL_MISSION)?.id).toBe('scanner')
    expect(nearestTarget({ x: 10.5, z: .1 }, INITIAL_MISSION)?.id).toBe('P1')
    for (const target of WALK_TARGETS) expect(nearestTarget(target, INITIAL_MISSION)?.id).toBe(target.id)
    const blocked = interact(INITIAL_MISSION, 'leak')
    expect(blocked.mission).toBe(INITIAL_MISSION)
    expect(blocked.message).toMatch(/сканер/i)
  })

  it('keeps a frozen reading and distinguishes main stand from training data', () => {
    const scanner = act(INITIAL_MISSION, 'scanner')
    const acquired = interact(scanner, 'P1', 490_000).mission
    expect(acquired.readings.P1).toEqual({ pressurePa: 490_000, source: 'stand' })
    expect(act(acquired, 'P2').readings.P2).toEqual({ pressurePa: 412_000, source: 'training' })
    expect(interact(acquired, 'P1', 510_000).mission.readings.P1?.pressurePa).toBe(510_000)
    expect(acquired.readings.P1?.pressurePa).toBe(490_000)
  })

  it('requires a scanner, all three readings, a prior scan and a sleeve', () => {
    const scanner = act(INITIAL_MISSION, 'scanner')
    expect(interact(INITIAL_MISSION, 'P1').mission).toBe(INITIAL_MISSION)
    const scanned = act(scanner, 'leak')
    expect(scanned.scanned).toBe(true)
    expect(act(scanned, 'leak')).toBe(scanned)
    const withSleeve = act(scanned, 'sleeve')
    expect(withSleeve.equipped).toBe('scanner')
    expect(act(withSleeve, 'leak')).toBe(withSleeve)
    const repaired = act(equipTool(withSleeve, 'sleeve').mission, 'leak')
    expect(repaired.repaired).toBe(true)
    expect(repaired.sleeve).toBe(false)
    expect(repaired.equipped).toBe('scanner')
    expect(act(repaired, 'leak')).toBe(repaired)
    expect(act(repaired, 'sleeve')).toBe(repaired)
    const complete = act(act(act(repaired, 'P1'), 'P2'), 'P3')
    expect(objective(complete).done).toBe(true)
    expect(objective(repaired).done).toBe(false)
    expect(act(act(complete, 'valve'), 'valve').valveClosed).toBe(false)
  })

  it('disallows unowned tools and requires the right equipped tool at the pipe and sensors', () => {
    expect(equipTool(INITIAL_MISSION, 'sleeve').mission).toBe(INITIAL_MISSION)
    const tools = act(act(INITIAL_MISSION, 'scanner'), 'sleeve')
    const sleeveInHand = equipTool(tools, 'sleeve').mission
    expect(interact(sleeveInHand, 'P1').mission).toBe(sleeveInHand)
    expect(interact(sleeveInHand, 'leak').mission).toBe(sleeveInHand)
    expect(interact(tools, 'leak').used).toBe('scanner')
  })

  it('checks the explicit world target without substituting a nearby target', () => {
    expect(targetInReach(INITIAL_POSITION, INITIAL_MISSION, 'P1')).toBeNull()
    expect(targetInReach(INITIAL_POSITION, INITIAL_MISSION, 'scanner')?.id).toBe('scanner')
    expect(targetInReach(INITIAL_POSITION, act(INITIAL_MISSION, 'scanner'), 'scanner')).toBeNull()
  })

  it('normalizes diagonal movement, accelerates sprinting and keeps the pipe out of reach of the avatar body', () => {
    const forward = movePlayer(INITIAL_POSITION, 0, 1, 0, false, 0.05)
    const diagonal = movePlayer(INITIAL_POSITION, 0, 1, 1, false, 0.05)
    const sprint = movePlayer(INITIAL_POSITION, 0, 1, 0, true, 0.05)
    expect(Math.hypot(diagonal.x, diagonal.z - INITIAL_POSITION.z)).toBeCloseTo(forward.x)
    expect(sprint.x).toBeGreaterThan(forward.x)
    expect(movePlayer({ x: 68, z: -1.2 }, 0, 1, -1, true, 1)).toEqual({ x: 68, z: -1.2 })
  })

  it('stops at equipment and allows the avatar to move around it', () => {
    const beforeCrate = { x: 1.2, z: 4.1 }
    expect(movePlayer(beforeCrate, 0, 1, 0, true, .05)).toEqual(beforeCrate)
    expect(movePlayer(beforeCrate, 0, 0, -1, false, .05).z).toBeLessThan(beforeCrate.z)
    expect(movePlayer({ x: 1.2, z: 3 }, 0, 1, 0, true, .05).x).toBeGreaterThan(beforeCrate.x)
  })
})
