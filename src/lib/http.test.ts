import { describe, expect, it } from 'vitest';
import { AppError, ok } from './http.js';

describe('ok', () => {
  it('membungkus payload dalam { data }', () => {
    expect(ok({ id: 'x' })).toEqual({ data: { id: 'x' } });
    expect(ok(null)).toEqual({ data: null });
  });
});

describe('AppError', () => {
  it('membawa statusCode 400 secara default', () => {
    const err = new AppError('buruk');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('buruk');
    expect(err.statusCode).toBe(400);
  });

  it('membawa statusCode kustom (dipakai route 403/404)', () => {
    expect(new AppError('tidak ada', 404).statusCode).toBe(404);
    expect(new AppError('dilarang', 403).statusCode).toBe(403);
  });
});
