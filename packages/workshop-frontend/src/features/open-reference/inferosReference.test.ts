import { describe, expect, it } from 'vitest'
import { MAX_REFERENCE_LENGTH, parseInferosReference } from './inferosReference'

const DO_ID = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef'
const GADGET = `inferops://grokbot.operations/inferos/gadget/${DO_ID}.7`
const BLUEPRINT = 'inferops://grokbot.operations/inferos/blueprint/inferlab.review-alerts'

describe('parseInferosReference', () => {
  it('reads a gadget address', () => {
    expect(parseInferosReference(GADGET, 'gadget')).toEqual({
      kind: 'gadget', company: 'grokbot', workspace: 'operations', workspaceDoId: DO_ID, gadgetId: 7,
    })
    expect(parseInferosReference(`inferops://a-1.b-2/inferos/gadget/${DO_ID}.0`, 'gadget'))
      .toMatchObject({ company: 'a-1', workspace: 'b-2', gadgetId: 0 })
  })

  it('reads a blueprint address', () => {
    expect(parseInferosReference(BLUEPRINT, 'blueprint')).toEqual({
      kind: 'blueprint', company: 'grokbot', workspace: 'operations', blueprintId: 'inferlab.review-alerts',
    })
    const hex = 'f'.repeat(32)
    expect(parseInferosReference(`inferops://grokbot.operations/inferos/blueprint/${hex}`, 'blueprint'))
      .toMatchObject({ blueprintId: hex })
  })

  it('refuses the other kind for each route', () => {
    expect(parseInferosReference(GADGET, 'blueprint')).toBeNull()
    expect(parseInferosReference(BLUEPRINT, 'gadget')).toBeNull()
  })

  it.each<[string, unknown]>([
    ['not a string', 7],
    ['an array of values', [GADGET]],
    ['empty', ''],
    ['another scheme', GADGET.replace('inferops://', 'https://')],
    ['an upper-case scheme', GADGET.replace('inferops://', 'INFEROPS://')],
    ['user info', GADGET.replace('inferops://', 'inferops://someone@')],
    ['a port', GADGET.replace('operations/', 'operations:443/')],
    ['a query', `${GADGET}?w=8`],
    ['a fragment', `${GADGET}#share=abc`],
    ['a percent-escape', GADGET.replace('/gadget/', '/gadget%2F')],
    ['an escaped dot', GADGET.replace(`${DO_ID}.7`, `${DO_ID}%2E7`)],
    ['an extra segment', `${GADGET}/more`],
    ['a trailing slash', `${GADGET}/`],
    ['a trailing newline', `${GADGET}\n`],
    ['leading space', ` ${GADGET}`],
    ['a missing workspace label', `inferops://grokbot/inferos/gadget/${DO_ID}.7`],
    ['a third host label', `inferops://grokbot.operations.extra/inferos/gadget/${DO_ID}.7`],
    ['an upper-case label', GADGET.replace('grokbot', 'Grokbot')],
    ['an underscore in a label', GADGET.replace('grokbot', 'grok_bot')],
    ['another product segment', GADGET.replace('/inferos/', '/project/')],
    ['upper-case hex', GADGET.replace(DO_ID, DO_ID.toUpperCase())],
    ['a short workspace id', GADGET.replace(DO_ID, DO_ID.slice(1))],
    ['a long workspace id', GADGET.replace(DO_ID, `${DO_ID}0`)],
    ['no gadget id', GADGET.replace(`${DO_ID}.7`, DO_ID)],
    ['a gadget id with a leading zero', GADGET.replace('.7', '.07')],
    ['a negative gadget id', GADGET.replace('.7', '.-7')],
    ['a fractional gadget id', GADGET.replace('.7', '.7.5')],
    ['a gadget id past a safe integer', GADGET.replace('.7', '.9999999999999999')],
    ['a path traversal', GADGET.replace(`${DO_ID}.7`, '../admin')],
  ])('refuses a gadget address with %s', (_, ref) => {
    expect(parseInferosReference(ref, 'gadget')).toBeNull()
  })

  it.each<[string, string]>([
    ['an id starting with a dot', BLUEPRINT.replace('inferlab.', '.inferlab.')],
    ['a dot-dot id', BLUEPRINT.replace('inferlab.review-alerts', '..')],
    ['a slash in the id', BLUEPRINT.replace('inferlab.', 'inferlab/')],
    ['a space in the id', BLUEPRINT.replace('inferlab.', 'inferlab ')],
    ['a percent-escape in the id', BLUEPRINT.replace('inferlab.', 'inferlab%2E')],
    ['an id over 128 characters', BLUEPRINT.replace('inferlab.review-alerts', 'a'.repeat(129))],
    ['a query', `${BLUEPRINT}?x=1`],
    ['a fragment', `${BLUEPRINT}#x`],
    ['an empty id', BLUEPRINT.replace('inferlab.review-alerts', '')],
  ])('refuses a blueprint address with %s', (_, ref) => {
    expect(parseInferosReference(ref, 'blueprint')).toBeNull()
  })

  it(`refuses anything over ${MAX_REFERENCE_LENGTH} characters`, () => {
    const atLimit = BLUEPRINT.replace('inferlab.review-alerts', 'a'.repeat(128))
    expect(parseInferosReference(atLimit, 'blueprint')).not.toBeNull()
    const company = 'c'.repeat(63)
    const labels = `${company}.${'w'.repeat(63)}`
    const long = `inferops://${labels}/inferos/blueprint/${'a'.repeat(128)}`
    expect(long.length).toBeLessThanOrEqual(MAX_REFERENCE_LENGTH)
    expect(parseInferosReference(long, 'blueprint')).not.toBeNull()
    expect(parseInferosReference(`${long}${'x'.repeat(MAX_REFERENCE_LENGTH)}`, 'blueprint')).toBeNull()
  })
})
