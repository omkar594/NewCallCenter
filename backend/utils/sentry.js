import * as Sentry from '@sentry/node';
import dotenv from 'dotenv';

// This module is imported early (before server.js's own dotenv.config() call further down its
// import chain) so it needs to load the .env file itself, same as asteriskService.js/ariService.js.
dotenv.config();

// Inert/no-op until SENTRY_DSN is set - lets this ship safely without requiring an account
// signup first. Turning it on later is just setting one env var on Render.
const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({ dsn, tracesSampleRate: 0 });
}

export function captureException(err, extra) {
  if (dsn) Sentry.captureException(err, extra ? { extra } : undefined);
}

export const enabled = Boolean(dsn);
