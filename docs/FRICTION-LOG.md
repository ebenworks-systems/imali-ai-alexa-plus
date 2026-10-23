# Friction log and feature requests

What got in our way while building Imali AI for Alexa+ for the Amazon Developer Hackathon, written on 23 October
2026. Each entry gives the task, the steps, what we expected and what happened, a severity, our workaround and a
suggestion. Timings are measured, from our workstation in Korea.

## Friction log

**1. Connecting a self-hosted MCP server to Alexa+.** Steps: read the track's Resources page and the hackathon FAQ,
looking for a way to register our server or open the Web Simulator. Expected: a sandbox to test an MCP server against
Alexa+. Actual: the Category SDK, MCP Toolkit, CLI and Web Simulator are partner-only, and the FAQ notes that some
setup pages do not say so. Severity: high (the real device path is blocked). Workaround: a simulated
Alexa+ screen that is a real MCP client. Suggestion: a public sandbox or simulator for hackathon entrants, and a
"partner-only" banner on every setup page.

**2. Giving a deploy user the permissions for AgentCore.** Steps: wrote one inline IAM policy for ECR, AgentCore,
DynamoDB, Cognito, logs and the runtime role, and tried to attach it to our existing deploy user. Expected: it attaches.
Actual: IAM refused it because a user's inline policies share a 2,048-character limit; and our first draft let the
deploy user create a role with any permissions and pass it, which is privilege escalation. Severity: medium.
Workaround: a customer-managed policy, the runtime role made once by an administrator, and `iam:PassRole` limited to
that role with `iam:PassedToService` set to bedrock-agentcore. Suggestion: publish a least-privilege deployer policy
and a runtime-role template (CloudFormation or CDK) for MCP servers next to the AgentCore permissions page.

**3. Building the ARM64 image on an x86 workstation.** Steps: `docker build` for AgentCore. Expected: build for any
architecture, or a clear managed build. Actual: AgentCore requires ARM64, and our workstation had no buildx or QEMU.
Severity: medium. Workaround: a Dockerfile with no RUN steps (production packages installed outside the image and
copied in), which the classic builder can produce for linux/arm64 without emulation. Suggestion: accept x86_64 images,
or document the Node.js code-zip deployment for protocol MCP (the walkthrough shows only Python).

**4. Session handling in stateful MCP mode.** Steps: assumed one MCP session per microVM and mapped unknown session
ids to the only open session. Expected: one caller per microVM. Actual: the runtime logs showed AgentCore sending its
own `initialize` (client "sandbox-agent") to warm microVMs, so a microVM can hold a session that is not the caller's.
Severity: low to medium (could misroute requests). Workaround: removed the mapping and relied on the platform's
session routing. Suggestion: document the probe sessions and exactly how `Mcp-Session-Id` is passed through in
stateful mode.

**5. Cold starts for a voice experience.** Steps: timed `initialize` after a redeploy. Expected: about the warm time.
Actual: about 7 s cold against 1.3 to 2.6 s warm (measured from Korea). Severity: low for this demo, medium for
voice, where a person is waiting. Workaround: none needed for the demo. Suggestion: an option to keep a minimum number
of warm microVMs for an MCP runtime.

**6. The optional GET stream.** Steps: the official SDK client opens the optional GET event stream after initialize.
Actual: AgentCore answers 405, the SDK carries on correctly, but the browser console logs an error that looks like a
failure. Severity: low. Suggestion: list which Streamable HTTP methods AgentCore supports (POST, GET stream, DELETE)
in the MCP protocol contract.

## Feature requests

1. **A public Alexa+ sandbox for self-hosted MCP servers** (Critical): register a server URL and try it in the Web
   Simulator on an Echo Show layout. Without it, every entrant builds a different imitation.
2. **Documented Alexa+ behaviour for elicitation and MCP Apps** (Important): whether a voice "yes" answers an
   elicitation form, and how cards and carousels from `ui://` resources render on Echo Show. Purchasing flows depend
   on the first; visual proof of a money record depends on the second.
3. **Account linking guidance for MCP servers on Alexa+** (Important): how a user's Alexa+ identity reaches the server
   so each owner sees their own books.
4. **AgentCore Runtime: x86_64 images or a managed build, and a Node.js code-zip example for MCP** (Important).
5. **AgentCore Runtime: minimum warm microVMs for MCP runtimes, and least-privilege IAM templates** (Nice-to-have).
