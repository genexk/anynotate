# Security

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue.

The bridge listens only on `127.0.0.1`, accepts browser requests only from allow-listed extension origins, and requires its owner-only token from every caller except `/health`. Reports about bypassing that boundary (other origins, other local users, DNS rebinding) or about bundle handling (path traversal, oversized uploads) are especially welcome.

You can expect an acknowledgement within a week.
