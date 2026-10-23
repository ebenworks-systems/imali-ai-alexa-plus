// Reads the owner's spoken or typed answer to a question the server asked. Only a clear yes confirms. Any no,
// not, don't, cancel, stop or wait turns it down, so "No, don't confirm that" and "not okay" never place an order.

const NO = /\b(no|nope|nah|not|never|don['’]?t|do not|cancel|stop|wait|hold on|decline|wrong)\b|n['’]t\b/i;
const YES = /\b(yes|yeah|yep|yup|sure|confirm|confirmed|go ahead|okay|ok|do it|place it)\b/i;

export function heardYes(text) {
  const said = String(text || "");
  return !NO.test(said) && YES.test(said);
}
