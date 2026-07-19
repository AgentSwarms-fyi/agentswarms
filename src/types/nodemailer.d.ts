// Minimal ambient declaration for the optional SMTP transport.
// nodemailer ships no types and is only loaded via a runtime dynamic import
// on Node deployments (see src/lib/email/mailer.server.ts), so a full
// @types/nodemailer dependency isn't warranted.
declare module "nodemailer";
