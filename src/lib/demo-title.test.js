import assert from "node:assert/strict";
import test from "node:test";
import { buildZoomAgenda, demoTitle } from "./demo-title.js";
import { bookDemoZoomDetails, zoomRegistrantNames } from "./server/zoom-scheduler.js";
import { createMeetingReminderContent, createMeetingScheduledContent } from "./server/mail.js";

test("names the demo from the selected service", () => {
  assert.equal(demoTitle("Company Store", "company-store-launch"), "Shopify Company Store Demo");
  assert.equal(demoTitle("Enterprise Company Store Automation", "enterprise-company-store-automation"), "Enterprise Company Store Automation Demo");
  assert.equal(demoTitle("Not sure yet", "not-sure-yet"), "General Enquiry Demo");
});

test("builds a Zoom agenda in the visitor timezone and keeps it within 2000 characters", () => {
  const details = bookDemoZoomDetails({
    source: "book-demo",
    displayName: "Ada Lovelace",
    fields: {
      solutionInterest: "Not sure yet",
      service: "not-sure-yet",
      notes: "Need a walkthrough of the current order flow.",
      timezone: "Asia/Karachi",
      meetingTimePkt: "Saturday, October 31, 2026 at 12:30 AM PKT",
    },
  }, new Date("2026-10-30T14:00:00.000Z"));

  assert.equal(details.topic, "General Enquiry Demo");
  assert.match(details.agenda, /^Service: General Enquiry\n/);
  assert.match(details.agenda, /Notes: Need a walkthrough of the current order flow\./);
  assert.match(details.agenda, /Meeting time: Friday, October 30, 2026 at 7:00 PM \(Asia\/Karachi\)/);
  assert.equal(details.agenda.includes("PKT"), false);
  assert.equal(details.agenda.includes("company-store-launch"), false);
  assert.equal(details.agenda.includes("Intent:"), false);
  assert.equal(details.agenda.includes("Swishtag demo"), false);
  assert.equal(details.agenda.length <= 2000, true);

  const huge = buildZoomAgenda({
    serviceName: "Shopify Company Store",
    notes: "A".repeat(4000),
    meetingTime: "Friday, October 30, 2026 at 7:00 AM (America/Phoenix)",
  });
  assert.equal(huge.length <= 2000, true);
  assert.match(huge, /^Service: Shopify Company Store\n/);
  assert.match(huge, /Meeting time: Friday, October 30, 2026 at 7:00 AM \(America\/Phoenix\)$/);
  assert.equal(huge.includes("PKT"), false);
});

test("meeting emails use the service title and omit Pakistan time", () => {
  const submission = {
    displayName: "Ada Lovelace",
    companyName: "Analytical Engines",
    email: "ada@example.com",
    fields: {
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
      solutionInterest: "Company Store",
      service: "company-store-launch",
      intent: "launch",
      timezone: "America/Phoenix",
      notes: "Bring the product list.",
      meetingTimePkt: "Friday, October 30, 2026 at 7:00 PM PKT",
    },
  };
  const meetingAt = new Date("2026-10-30T14:00:00.000Z");
  const customer = createMeetingScheduledContent(submission, meetingAt, "customer");
  const internal = createMeetingScheduledContent(submission, meetingAt, "internal");
  const reminder = createMeetingReminderContent(submission, meetingAt, "customer");

  for (const content of [customer, internal, reminder]) {
    assert.equal(content.heading, "Shopify Company Store Demo");
    assert.equal(/swishtag demo/i.test(content.subject + content.heading + content.summary), false);
    assert.equal(content.textBody.includes("PKT"), false);
    assert.match(content.textBody, /7:00 AM \(America\/Phoenix\)/);
  }
  assert.equal(customer.subject, "Your Shopify Company Store Demo is scheduled");
  assert.equal(customer.textBody.includes("company-store-launch"), false);
  assert.equal(customer.textBody.includes("Intent:"), false);
  assert.equal(reminder.textBody.includes("company-store-launch"), false);
  assert.match(internal.textBody, /Service: company-store-launch/);
  assert.match(internal.textBody, /Intent: launch/);
  assert.match(reminder.subject, /Shopify Company Store Demo/);
});

test("Zoom registrant names come from the submitted first and last name", () => {
  assert.deepEqual(zoomRegistrantNames({
    fields: { firstName: "Ada", lastName: "Lovelace" },
    customerName: "Someone Else",
  }), { firstName: "Ada", lastName: "Lovelace" });
  assert.equal(zoomRegistrantNames({ customerName: "Ada Lovelace", displayName: "Ada Lovelace" }), null);

  const details = bookDemoZoomDetails({
    fields: {
      firstName: "Ada",
      lastName: "Lovelace",
      solutionInterest: "Company Store",
      service: "company-store-launch",
      intent: "launch",
      notes: "Please review the catalog.",
      timezone: "America/Phoenix",
    },
  }, new Date("2026-10-30T14:00:00.000Z"));
  assert.equal(details.topic, "Shopify Company Store Demo");
  assert.match(details.agenda, /Service: Shopify Company Store/);
  assert.equal(details.agenda.includes("company-store-launch"), false);
  assert.equal(details.agenda.includes("Intent:"), false);
});
