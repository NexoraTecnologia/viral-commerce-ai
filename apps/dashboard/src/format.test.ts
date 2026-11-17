import { describe, expect, it } from 'vitest';
import { parseMoneyInput, parsePercentInput } from './format';

describe('parseMoneyInput', () => {
  it.each([
    ['1234', 123_400],
    ['1234,5', 123_450],
    ['1234.56', 123_456],
    ['1.234,56', 123_456],
    ['1.234.567', 123_456_700],
    // Formato es-AR: un punto seguido de 3 dígitos es separador de miles.
    ['12.345', 1_234_500],
    ['$ 25.999,90', 2_599_990],
    ['0', 0],
  ])('%s → %i centavos', (raw, cents) => {
    expect(parseMoneyInput(raw)).toBe(cents);
  });

  it.each(['', 'abc', '-5', '1,234,56', '1,999'])('rechaza %s', (raw) => {
    expect(parseMoneyInput(raw)).toBeNull();
  });
});

describe('parsePercentInput', () => {
  it('convierte a basis points', () => {
    expect(parsePercentInput('13')).toBe(1_300);
    expect(parsePercentInput('4,99')).toBe(499);
    expect(parsePercentInput('100')).toBe(10_000);
  });

  it('rechaza valores fuera de rango o inválidos', () => {
    expect(parsePercentInput('101')).toBeNull();
    expect(parsePercentInput('-1')).toBeNull();
    expect(parsePercentInput('x')).toBeNull();
  });
});
