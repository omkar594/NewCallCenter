// Guards the handful of endpoints Asterisk's dialplan hits directly via CURL() - they can't
// carry a JWT (Asterisk has no way to attach a bearer token), so authenticateToken doesn't apply
// here. Without this, anyone on the internet who finds the URL could call them freely.
//
// Soft-enforced by design: if CAMPAIGN_WEBHOOK_SECRET isn't set, requests are still allowed
// through (loudly logged) rather than breaking a live dialplan that hasn't been updated with the
// secret yet. Set the env var on the backend AND add &secret=<value> to the matching CURL() call
// in telephony_config/extensions.conf to make this actually enforce.
export function requireWebhookSecret(req, res, next) {
  const configuredSecret = process.env.CAMPAIGN_WEBHOOK_SECRET;
  if (!configuredSecret) {
    console.warn(`[Webhook] ${req.path} called with no CAMPAIGN_WEBHOOK_SECRET configured - request allowed but unauthenticated. Set this env var (and update extensions.conf's CURL() call) to require a shared secret.`);
    return next();
  }
  const provided = req.query.secret || req.body?.secret;
  if (provided !== configuredSecret) {
    console.warn(`[Webhook] ${req.path} called with an invalid or missing webhook secret.`);
    return res.status(403).json({ error: 'Invalid or missing webhook secret' });
  }
  next();
}
