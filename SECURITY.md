# Security Policy

## Supported Versions

We actively support and provide security updates for the following versions of LibreDB Studio:

| Version | Supported          |
| ------- | ------------------ |
| 0.9.x   | :white_check_mark: |
| < 0.9.0 | :x:                |

> **Note**: We recommend always using the latest version to ensure you have the most recent security patches.

## Reporting a Vulnerability

We take the security of LibreDB Studio seriously. If you believe you have found a security vulnerability, please report it to us as described below.

### How to Report

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to:

**Email:** info@sekoya.tech

Reports are handled by Sekoya Grup Bilişim ve Teknoloji Ltd. Şti., the
maintainer of LibreDB Studio.

### What to Include

When reporting a security vulnerability, please include the following information:

- **Type of issue** (e.g., buffer overflow, SQL injection, cross-site scripting, etc.)
- **Full paths of source file(s) related to the manifestation of the issue**
- **The location of the affected source code** (tag/branch/commit or direct URL)
- **Step-by-step instructions to reproduce the issue**
- **Proof-of-concept or exploit code** (if possible)
- **Impact of the issue**, including how an attacker might exploit the issue

This information will help us triage your report more quickly.

### What to Expect

- **Acknowledgment**: We will acknowledge receipt of your vulnerability report within **48 hours**
- **Initial Assessment**: We will provide an initial assessment within **7 days**
- **Updates**: We will keep you informed of our progress every 7-10 days
- **Resolution**: We will work with you to understand and resolve the issue quickly

### Disclosure Policy

- We will coordinate with you to fix the vulnerability before public disclosure
- We will credit you for the discovery (unless you prefer to remain anonymous)
- We will not take legal action against security researchers who:
  - Act in good faith
  - Do not access more data than necessary
  - Do not modify or delete data
  - Do not disrupt our services
  - Report vulnerabilities promptly

### Security Best Practices

When using LibreDB Studio, please follow these security best practices:

1. **Keep Updated**: Always use the latest version of LibreDB Studio
2. **Secure Credentials**: Use strong passwords for `ADMIN_PASSWORD` and `USER_PASSWORD`
3. **JWT Secret**: Generate a secure `JWT_SECRET` using `openssl rand -base64 32`
4. **Environment Variables**: Never commit `.env.local` or `.env` files to version control
5. **Network Security**: Deploy behind a firewall or VPN when accessing production databases
6. **Database Access**: Use read-only database users when possible
7. **HTTPS**: Always use HTTPS in production environments
8. **API Keys**: Store LLM API keys securely and rotate them regularly

### Known Security Considerations

#### Authentication
- LibreDB Studio uses JWT-based authentication
- Passwords are hashed using industry-standard algorithms
- Session tokens expire after a configurable period

#### Database Connections
- Connection strings are stored encrypted in browser localStorage
- Database credentials are never logged or exposed in API responses
- Connection pooling is used to prevent connection exhaustion

#### API Security
- All API endpoints require authentication (except `/api/auth/login`)
- SQL injection protection is handled by parameterized queries
- Rate limiting should be implemented at the infrastructure level

#### AI/LLM Integration
- API keys are stored server-side only
- User queries sent to LLM providers may be logged by the provider
- Consider privacy implications when using cloud-based LLM services

### Security Updates

Security updates will be released as:
- **Patch releases** (e.g., 0.5.4 → 0.5.5) for critical security fixes
- **Minor releases** (e.g., 0.5.x → 0.6.0) for security improvements
- **Security advisories** will be published in the GitHub Security tab

### Security Audit

If you are conducting a security audit or penetration test, please contact us in advance at info@sekoya.tech so we can coordinate and ensure your testing does not impact other users.

---

**Thank you for helping keep LibreDB Studio and our users safe!**

