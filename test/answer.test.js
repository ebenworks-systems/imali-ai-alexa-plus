// The owner's answer to a confirmation: only a clear yes places an order.

import assert from "node:assert/strict";
import { test } from "node:test";
import { heardYes } from "../web/answer.js";

test("a clear yes confirms", () => {
  for (const said of ["yes", "Yes please", "yeah", "okay, go ahead", "Sure", "confirm", "OK do it"]) assert.equal(heardYes(said), true, said);
});

test("any no, not or don't turns it down, even next to a yes word", () => {
  for (const said of ["No, don't confirm that", "not okay", "no", "Nope", "cancel it", "yes, wait", "I don't know", "don’t", "that isn't right", "stop", "hold on, okay"]) assert.equal(heardYes(said), false, said);
});

test("silence or an unclear answer is not a yes", () => {
  for (const said of ["", "maybe", "how much is it?", undefined]) assert.equal(heardYes(said), false, String(said));
});
