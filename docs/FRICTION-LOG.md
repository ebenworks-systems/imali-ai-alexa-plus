# Friction log and feature requests

What got in our way while building Imali AI for Alexa+ for the Amazon Developer Hackathon, written on 23 October
2026. Seven entries, each with the fields the rules ask for: task, steps, expected, actual, severity, workaround and
suggestion. Timings are measured, from our workstation in Korea, on 23 October 2026.

## Friction log

### 1. Connecting a self-hosted MCP server to Alexa+

- **Task:** test our MCP server on Alexa+ itself.
- **Steps:** read the track's Resources page and the hackathon FAQ, looking for a way to register a server or open the
  Web Simulator.
- **Expected:** a sandbox to try a self-hosted MCP server against Alexa+.
- **Actual:** the Category SDK, MCP Toolkit, CLI and Web Simulator are open to select partners only; the FAQ notes that
  some setup pages do not say so.
- **Severity:** high: the real device path is blocked for every entrant.
- **Workaround:** a simulated Alexa+ screen that is a real MCP client, hosted so judges can use it.
- **Suggestion:** a public sandbox or simulator for hackathon entrants, and a "partner-only" banner on every setup page.

### 2. Giving a deploy user the permissions for AgentCore

- **Task:** let our command-line deploy user create the AgentCore runtime, ECR repository, DynamoDB table and Cognito
  pool.
- **Steps:** wrote one inline IAM policy for ECR, AgentCore, DynamoDB, Cognito, logs and the runtime role, and tried to
  attach it to the existing deploy user.
- **Expected:** it attaches.
- **Actual:** IAM refused it, because a user's inline policies share a 2,048-character limit. Our first draft also let
  the deploy user create a role with any permissions and pass it, which is privilege escalation.
- **Severity:** medium.
- **Workaround:** a customer-managed policy, the runtime role made once by an administrator, and `iam:PassRole` limited
  to that role with `iam:PassedToService` set to bedrock-agentcore.
- **Suggestion:** publish a least-privilege deployer policy and a runtime-role template (CloudFormation or CDK) for MCP
  servers next to the AgentCore permissions page.

### 3. Building the ARM64 image on an x86 workstation

- **Task:** build the container image AgentCore runs.
- **Steps:** `docker build` on our x86 workstation.
- **Expected:** a build for any architecture, or a clear managed build.
- **Actual:** AgentCore requires ARM64, and the workstation had no buildx or QEMU emulator.
- **Severity:** medium.
- **Workaround:** a Dockerfile with no RUN steps (production packages installed outside the image and copied in),
  which the classic builder can produce for linux/arm64 without emulation.
- **Suggestion:** accept x86_64 images, or document the Node.js code-zip deployment for protocol MCP (the walkthrough
  shows only Python).

### 4. Session handling in stateful MCP mode

- **Task:** keep MCP sessions stateful on AgentCore so elicitation works.
- **Steps:** assumed one MCP session per microVM and mapped unknown session ids to the only open session.
- **Expected:** one caller per microVM.
- **Actual:** the runtime logs showed AgentCore sending its own `initialize` (client "sandbox-agent") to warm
  microVMs, so a microVM can hold a session that is not the caller's.
- **Severity:** low to medium: the mapping could have misrouted requests.
- **Workaround:** removed the mapping and relied on the platform's session routing.
- **Suggestion:** document the probe sessions and exactly how `Mcp-Session-Id` is passed through in stateful mode.

### 5. Cold starts for a voice experience

- **Task:** answer a spoken request quickly from a new session.
- **Steps:** timed `initialize` after each redeploy and on warm runtimes.
- **Expected:** about the warm time.
- **Actual:** about 7 s cold against 1.2 to 2.6 s warm.
- **Severity:** low for this demo, medium for voice, where a person is waiting at the counter.
- **Workaround:** none in the demo; the page connects when it opens, before the owner speaks.
- **Suggestion:** an option to keep a minimum number of warm microVMs for an MCP runtime.

### 6. The optional GET stream

- **Task:** connect the official SDK client in a browser to the AgentCore endpoint.
- **Steps:** the client opens the optional GET event stream after `initialize`, as the Streamable HTTP spec allows.
- **Expected:** a stream, or a documented refusal.
- **Actual:** AgentCore answers 405; the SDK carries on correctly, but the browser console logs an error that looks
  like a failure.
- **Severity:** low.
- **Workaround:** none needed; we note it in the README.
- **Suggestion:** list which Streamable HTTP methods AgentCore supports (POST, GET stream, DELETE) in the MCP protocol
  contract.

### 7. One AgentCore runtime calling another as the same user

- **Task:** let the shop books runtime call the supplier network runtime over MCP on behalf of the signed-in owner.
- **Steps:** deployed both runtimes from the same image with the same Cognito JWT authorizer and `Authorization` in the
  request-header allowlist; the books server forwards the caller's bearer token to the supplier runtime.
- **Expected:** a documented pattern for runtime-to-runtime MCP calls.
- **Actual:** the Runtime pages we read (MCP protocol contract, stateful MCP features, sessions, inbound auth) cover
  inbound calls only; we did not try AgentCore Gateway or AgentCore Identity's outbound auth in the time we had.
  Forwarding the token worked. The second runtime's cold start adds to the first call: the first reorder of a session
  took 8.8 s with the supplier runtime cold, against 3.5 s warm.
- **Severity:** low to medium.
- **Workaround:** token pass-through, and a 20-second timeout after which the order stays in the books and the owner is
  told.
- **Suggestion:** a sample for one runtime calling another as the caller (token pass-through or Gateway), with a note on
  how cold starts add up across runtimes.

## Feature requests

1. **A public Alexa+ sandbox for self-hosted MCP servers** (Critical): register a server URL and try it in the Web
   Simulator on an Echo Show layout. Without it, every entrant builds a different imitation.
2. **Documented Alexa+ behaviour for elicitation and MCP Apps** (Important): whether a voice "yes" answers an
   elicitation form, and how cards and carousels from `ui://` resources render on Echo Show. Purchasing flows depend
   on the first; visual proof of a money record depends on the second.
3. **Account linking guidance for MCP servers on Alexa+** (Important): how a user's Alexa+ identity reaches the server
   so each owner sees their own books.
4. **AgentCore Runtime: x86_64 images or a managed build, and a Node.js code-zip example for MCP** (Important).
5. **AgentCore Runtime: runtime-to-runtime MCP calls as the caller, minimum warm microVMs, and least-privilege IAM
   templates** (Nice-to-have).
