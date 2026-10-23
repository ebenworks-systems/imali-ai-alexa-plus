// Signs in to the Amazon Cognito pool in front of the AgentCore runtime and prints an access token.
// COGNITO_CLIENT_ID, COGNITO_USER and COGNITO_PASSWORD come from the environment; AWS_REGION defaults to us-east-1.
//   MCP_TOKEN=$(node scripts/aws-token.mjs) MCP_SHOP_HEADER=X-Amzn-Bedrock-AgentCore-Runtime-Custom-Shop node scripts/smoke.mjs "$MCP_URL"

const region = process.env.AWS_REGION || "us-east-1";
const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
  method: "POST",
  headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth" },
  body: JSON.stringify({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: process.env.COGNITO_CLIENT_ID, AuthParameters: { USERNAME: process.env.COGNITO_USER, PASSWORD: process.env.COGNITO_PASSWORD } }),
});
const data = await res.json();
if (!res.ok || !data.AuthenticationResult) {
  console.error(`sign-in failed: ${res.status} ${data.__type || ""}`);
  process.exit(1);
}
process.stdout.write(data.AuthenticationResult.AccessToken);
