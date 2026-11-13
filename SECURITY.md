# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 4.x.x   | :white_check_mark: |
| 3.x.x   | :white_check_mark: |
| < 3.0   | :x:                |

The 4.x line is current; 3.0.0 replaced the NSSM-hosted service with
`owlette-host` and is the floor for everything since. Agents older than 3.x are
not supported and should be upgraded through the installer rather than patched.

## Reporting a Vulnerability

We take the security of Owlette seriously. If you believe you have found a security vulnerability, please report it to us responsibly.

### How to Report

**Please do NOT report security vulnerabilities through public GitHub issues.**

Instead, please send an email to: **support@tridant.io**

Include the following information in your report:

- Type of vulnerability (e.g., XSS, SQL injection, authentication bypass)
- Full paths of source file(s) related to the vulnerability
- Location of the affected source code (tag/branch/commit or direct URL)
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

### What to Expect

- **Acknowledgment**: We will acknowledge receipt of your report within 48 hours.
- **Communication**: We will keep you informed of our progress toward resolving the issue.
- **Timeline**: We aim to resolve critical vulnerabilities within 7 days, and other issues within 30 days.
- **Credit**: We will credit you in our release notes (unless you prefer to remain anonymous).

### Safe Harbor

We consider security research conducted in accordance with this policy to be:

- Authorized concerning any applicable anti-hacking laws
- Authorized concerning any relevant anti-circumvention laws
- Exempt from restrictions in our Terms of Service that would interfere with conducting security research

We will not pursue civil action or initiate a complaint to law enforcement for accidental, good-faith violations of this policy.

### Scope

The following are in scope for security research:

- Owlette web application (owlette.app)
- Owlette agent on Windows, macOS and Linux, its desktop app and owlette swoop
- API endpoints
- Authentication and authorization mechanisms
- Data storage and encryption

The following are out of scope:

- Denial of service attacks
- Social engineering attacks
- Physical attacks against our infrastructure
- Attacks against third-party services we use (Firebase, etc.)

## Security Best Practices for Users

### Account Security

- Every account sets up two-factor authentication (2FA); a passkey, an authenticator app or both
- Use a strong, unique password
- Keep your backup codes in a secure location
- Review connected machines regularly

### Agent Security

- Only install the Owlette agent on machines you own or have authorization to manage
- Keep the agent updated to the latest version
- Protect the machine where the agent is installed with standard security practices
- Revoke machine tokens immediately if a machine is compromised

### API Keys

- Never share your API keys, and send them only in a header (`Authorization: Bearer` or `x-api-key`)
- Rotate keys periodically
- Use the minimum required scopes and tool tier
- Revoke keys that are no longer needed

## Security Features

Owlette implements the following security measures:

- **Encryption in Transit**: All communications use TLS/HTTPS
- **Encryption at Rest**: Secrets the server keeps, such as authenticator secrets and LLM keys, are encrypted with AES-256-GCM; an agent's token store is encrypted under a machine-bound key
- **Two-Factor Authentication**: authenticator app (TOTP) or passkey, with backup codes; a session reaches the dashboard and the API only after its second factor, and swoop control asks for it again (step-up)
- **Token Security**: Short-lived access tokens with encrypted refresh tokens
- **Rate Limiting**: API endpoints are rate-limited to prevent abuse
- **Audit Logging**: Security-relevant actions are logged

## Contact

For security questions and vulnerability reports, contact: support@tridant.io
