# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration keeps, and where:

- the Miele **access and refresh tokens**, and the anti-CSRF state of a sign-in
  in progress (15 minutes at most), in `/data/miele-auth.json`, readable by the
  container user only — never in the Gladys configuration, never in the logs;
- the Miele **client ID** and **client secret**, in the Gladys configuration
  (the secret is a `secret` field: Gladys never sends it back to the browser).

Network: the container only talks to `api.mcs3.miele.com` (OAuth and API, over
HTTPS) and to Gladys. It opens no port. The Miele password is typed on Miele's
own page, never in Gladys.

Commands: the integration never turns on, nor starts a program on, an oven, a
hob, a microwave or a warming drawer, whatever the API allows. A way around
this rule is a vulnerability: please report it.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
the Gladys OAuth redirect page, and the Miele cloud and appliances.
