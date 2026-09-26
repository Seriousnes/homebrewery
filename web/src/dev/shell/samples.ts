// Sample failures for /dev/shell: what ErrorNavItem and ErrorPage show for each API outcome.
import { ApiError } from '@/api';

function problem(status: number, body: Record<string, unknown>): ApiError {
  return ApiError.fromResponse(new Response(null, { status }), body, { method: 'PUT', url: '/api/brews/sample-edit' });
}

export const ERROR_SAMPLES = {
  network: () => ApiError.network(new TypeError('Failed to fetch'), { method: 'PUT', url: '/api/brews/sample-edit' }),
  '401': () => problem(401, { title: 'Unauthorized', status: 401 }),
  '403': () => problem(403, { title: 'Forbidden', status: 403, detail: 'Only the authors of this brew can save it.' }),
  '404': () => problem(404, { title: 'Brew not found', status: 404 }),
  '409': () => problem(409, { title: 'Version conflict', status: 409, serverVersion: 7 }),
  '413': () => problem(413, { title: 'Payload too large', status: 413 }),
  '423': () =>
    problem(423, {
      title: 'Brew locked',
      status: 423,
      detail: 'This brew breaks the content rules. Remove the copied text, then ask for a review.',
      code: 455,
    }),
  '400': () =>
    problem(400, {
      title: 'The brew is not valid.',
      status: 400,
      errors: { 'meta.title': ['The title must be at most 100 characters.'] },
    }),
  '500': () => problem(500, { title: 'Internal Server Error', status: 500 }),
} as const;

export type ErrorSample = keyof typeof ERROR_SAMPLES;

export const ERROR_SAMPLE_KEYS = Object.keys(ERROR_SAMPLES) as ErrorSample[];
