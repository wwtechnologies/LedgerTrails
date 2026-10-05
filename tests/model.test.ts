import assert from "node:assert/strict";
import test from "node:test";
import { formatAmount, totals } from "../src/model.ts";
test("amount display preserves precision above JavaScript safe integers", () => {
  assert.equal(
    formatAmount({ quantity: "9007199254740993.12345", commodity: "USD" }),
    "9,007,199,254,740,993.12345 USD",
  );
  assert.equal(
    formatAmount({ quantity: "-0.001", commodity: "BTC" }),
    "−0.001 BTC",
  );
});
test("totals use exact decimals, separate currencies, and respect account boundaries", () => {
  assert.deepEqual(
    totals(
      [
        {
          name: "assets:bank",
          amounts: [
            { quantity: "0.1", commodity: "USD" },
            { quantity: "12", commodity: "EUR" },
          ],
        },
        {
          name: "assets:cash",
          amounts: [{ quantity: "0.2", commodity: "USD" }],
        },
        {
          name: "liabilities:card",
          amounts: [{ quantity: "-0.1", commodity: "USD" }],
        },
        {
          name: "assets-other",
          amounts: [{ quantity: "999", commodity: "USD" }],
        },
      ],
      ["assets", "liabilities"],
    ),
    [
      { commodity: "USD", quantity: "0.2" },
      { commodity: "EUR", quantity: "12" },
    ],
  );
});
test("income presentation reverses credit sign", () => {
  assert.deepEqual(
    totals(
      [
        {
          name: "income:work",
          amounts: [{ quantity: "-200", commodity: "USD" }],
        },
      ],
      ["income"],
      true,
    ),
    [{ commodity: "USD", quantity: "200" }],
  );
});
