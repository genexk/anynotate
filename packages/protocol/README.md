# @anynotate/protocol

Types and zod schemas for the Anynotate wire format: the bundle a client (such as the Anynotate Chrome extension) sends to the local Anynotate bridge, and the session and status objects the bridge returns. [PROTOCOL.md](./PROTOCOL.md) documents the HTTP API and the bundle folder layout.

```bash
npm install @anynotate/protocol
```

```ts
import { BundleInput, type Session } from "@anynotate/protocol";

const parsed = BundleInput.safeParse(payload);
```

Request/response examples for the extension-facing endpoints: `import { conformance } from "@anynotate/protocol/fixtures"`.

Versions below 1.0 may change the wire format between minor releases.

## License

Apache-2.0. The rest of the [Anynotate repository](https://github.com/genexk/anynotate) is AGPL-3.0.
