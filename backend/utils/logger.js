import pino from 'pino';

// Structured JSON logs (level, msg, and whatever fields a call site attaches) so a hosting
// platform's log search/alerting can filter on severity instead of grepping raw console strings.
const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

export default logger;
