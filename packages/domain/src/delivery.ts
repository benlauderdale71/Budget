export interface TestDelivery {
  status: "accepted" | "queued" | "failed" | "refused";
  provenDelivered: false;
  note: string;
}

/** A test sink can accept a message. Acceptance is never proof that a person received it. */
export function classifyTestDelivery(input: { outcome: "accepted" | "rejected"; quiet: boolean; optedOut: boolean; consented: boolean }): TestDelivery {
  if (!input.consented || input.optedOut) {
    return { status: "refused", provenDelivered: false, note: "No message was sent. Consent is missing or this channel was opted out." };
  }
  if (input.quiet) {
    return { status: "queued", provenDelivered: false, note: "Quiet hours held this message. It was not sent and it was not delivered." };
  }
  if (input.outcome === "rejected") {
    return { status: "failed", provenDelivered: false, note: "The test sink rejected the message. It was not delivered." };
  }
  return { status: "accepted", provenDelivered: false, note: "The test sink accepted the message. Acceptance is not proof that a person received it." };
}
