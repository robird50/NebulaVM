# VM Start Verification

Every normal VM Start, including the Windows 11 Template shortcut, requests a
fresh hCaptcha challenge. Cancelling verification does not start or stop a VM.
Browser runtimes verify the response through a Netlify Function. Hyper-V,
native QEMU, and Android verify it at their host's start endpoint before launching.
Browser-local emulation cannot be secured against a visitor modifying their own
JavaScript; host-side start authorization is enforced independently.

## Configuration

Set `HCAPTCHA_SITE_KEY` and `HCAPTCHA_SECRET` in both:

- Netlify project environment variables, with Functions scope for production.
- The active Windows host's private `.env.local` file (or its environment). The
  host may instead set `HCAPTCHA_SECRET_FILE` to an absolute path containing only
  the secret, keeping the value out of the project directory.

Use the same sitekey on both servers. The hCaptcha dashboard must allow
`nebulavm.online` and any deliberately supported test hostname. Do not use
localhost or 127.0.0.1 as a real hCaptcha site hostname.

The secret must never have a `VITE_` prefix, be put in a browser bundle, or be
committed to Git. Restart the Windows bridge after its configuration is updated,
and redeploy the Netlify site and functions together. Deploy the updated host
start checks alongside the frontend; old host versions do not enforce them.
Missing keys fail closed, so configure both environments before publishing.

`captcha.html` runs in a frame that fades into the VM viewport because emulator
pages require cross-origin isolation. A credentialless iframe and a page-specific
COEP exception allow the provider widget to load without weakening the main
emulator page. A random,
per-attempt BroadcastChannel plus same-origin messaging carries the response
back; the callback alone is not trusted by the server. The normal page retains
COOP/COEP protections.

Each token is verified with hCaptcha's siteverify endpoint, scoped to the
configured sitekey. No successful token is saved or reused. Network errors,
invalid responses, expired tokens, and duplicate tokens block the start.

## Verification

Run `npm test` and `npm run build`. Test each Start path in a browser after
configuration, including cancel, frame isolation, verification failure, and a
second start requiring a new challenge. Do not use hCaptcha's always-pass test
keys in production.
