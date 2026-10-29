import assert from "node:assert/strict";
import test from "node:test";
import { buildOfferedSlots, describeSlot } from "../../../lib/meeting-slots.js";
import { GET as getAvailability } from "../book-demo/availability.js";
import { GET as getCities } from "../locations/cities.js";
import { GET as getCountries } from "../locations/countries.js";
import { POST } from "./submit.js";

const SERVICE_ENV = /^(MONGODB_|MYSQL_|MAIL_|ZOOM_|MEETING_|DB_|FORM_SUBMISSIONS_COLLECTION$)/;

function withoutServiceEnv(run) {
  const saved = new Map();
  for (const key of Object.keys(process.env)) {
    if (SERVICE_ENV.test(key)) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }

  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of saved) process.env[key] = value;
    });
}

function memoryCollection(initial = []) {
  const rows = initial.map(row => ({ ...row }));
  let seq = rows.length;

  return {
    rows,
    failUpdates: false,
    async insertOne(document) {
      seq += 1;
      document._id = String(seq);
      rows.push(document);
      return { insertedId: document._id };
    },
    async deleteOne(filter) {
      const index = rows.findIndex(row => String(row._id) === String(filter._id));
      if (index < 0) return { deletedCount: 0 };
      rows.splice(index, 1);
      return { deletedCount: 1 };
    },
    async updateOne(filter, update) {
      if (this.failUpdates) throw new Error("status update failed");
      const row = rows.find(item => String(item._id) === String(filter._id));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(row, update.$set || {});
      for (const key of Object.keys(update.$unset || {})) delete row[key];
      return { matchedCount: 1, modifiedCount: 1 };
    },
    find() {
      const cursor = {
        limit() {
          return cursor;
        },
        async toArray() {
          return rows.slice();
        },
      };
      return cursor;
    },
  };
}

function bookDemoPayload() {
  const slot = buildOfferedSlots("America/Chicago")[0];
  return {
    form_source: "book-demo",
    fullName: "Ada Lovelace",
    workEmail: "ada@example.com",
    companyName: "Analytical Engines",
    country: "United States",
    countryCode: "US",
    city: "Austin, Texas",
    solutionInterest: "Company Store",
    ...describeSlot(slot, "America/Chicago"),
  };
}

function contactPayload() {
  return {
    form_source: "contact",
    fullName: "Ada Lovelace",
    firstName: "Ada",
    lastName: "Lovelace",
    workEmail: "ada@example.com",
    companyName: "Analytical Engines",
    role: "Promotional Products Distributor",
    topic: "General Inquiry",
    message: "Hello from the contact form.",
  };
}

function requestFor(body) {
  return new Request("https://swishtag.com/api/forms/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function zoomSuccess() {
  return {
    meeting: {
      id: "zm-1",
      joinUrl: "https://zoom.example/j/1",
      startUrl: "https://zoom.example/s/1",
    },
    registrant: { id: "reg-1" },
    registrantError: null,
    invitees: ["hello@swishtag.com"],
  };
}

function mailSuccess(subject) {
  return { recipients: ["hello@swishtag.com"], subject };
}

test("book-demo returns 200 when Zoom and mail succeed without service env", async () => {
  await withoutServiceEnv(async () => {
    const collection = memoryCollection();
    const calls = { zoom: 0, notify: 0, confirm: 0 };
    const response = await POST({ request: requestFor(bookDemoPayload()) }, {
      getSubmissionCollection: async () => collection,
      isZoomSchedulerEnabled: () => true,
      createZoomMeetingForSubmission: async () => {
        calls.zoom += 1;
        return zoomSuccess();
      },
      sendSubmissionEmail: async () => {
        calls.notify += 1;
        return mailSuccess("New book demo request");
      },
      sendMeetingScheduledEmail: async () => {
        calls.confirm += 1;
        return mailSuccess("Your Swishtag demo is scheduled");
      },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.warning, undefined);
    assert.equal(calls.zoom, 1);
    assert.equal(calls.notify, 1);
    assert.equal(calls.confirm, 1);
    assert.equal(collection.rows.length, 1);
    assert.equal(collection.rows[0].zoomStatus, "created");
    assert.equal(collection.rows[0].emailStatus, "sent");
    assert.equal(collection.rows[0].meetingConfirmationStatus, "sent");
    assert.equal(collection.rows[0].zoomMeeting.joinUrl, "https://zoom.example/j/1");
  });
});

test("book-demo returns 200 when Zoom is off and still sends both emails", async () => {
  await withoutServiceEnv(async () => {
    const collection = memoryCollection();
    const calls = { zoom: 0, notify: 0, confirm: 0 };
    const response = await POST({ request: requestFor(bookDemoPayload()) }, {
      getSubmissionCollection: async () => collection,
      isZoomSchedulerEnabled: () => false,
      createZoomMeetingForSubmission: async () => {
        calls.zoom += 1;
        throw new Error("Zoom should not be called");
      },
      sendSubmissionEmail: async () => {
        calls.notify += 1;
        return mailSuccess("New book demo request");
      },
      sendMeetingScheduledEmail: async () => {
        calls.confirm += 1;
        return mailSuccess("Your Swishtag demo is scheduled");
      },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.warning, undefined);
    assert.equal(calls.zoom, 0);
    assert.equal(calls.notify, 1);
    assert.equal(calls.confirm, 1);
    assert.equal(collection.rows[0].zoomStatus, "disabled");
    assert.equal(collection.rows[0].emailStatus, "sent");
  });
});

test("contact form returns 200 without Zoom or a meeting confirmation", async () => {
  await withoutServiceEnv(async () => {
    const collection = memoryCollection();
    const calls = { zoom: 0, notify: 0, confirm: 0 };
    const response = await POST({ request: requestFor(contactPayload()) }, {
      getSubmissionCollection: async () => collection,
      isZoomSchedulerEnabled: () => true,
      createZoomMeetingForSubmission: async () => {
        calls.zoom += 1;
        return zoomSuccess();
      },
      sendSubmissionEmail: async () => {
        calls.notify += 1;
        return mailSuccess("New contact inquiry");
      },
      sendMeetingScheduledEmail: async () => {
        calls.confirm += 1;
        return mailSuccess("unused");
      },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(calls.zoom, 0);
    assert.equal(calls.notify, 1);
    assert.equal(calls.confirm, 0);
    assert.equal(collection.rows[0].formType, "contact");
    assert.equal(collection.rows[0].emailStatus, "sent");
    assert.equal(collection.rows[0].zoomStatus, "not_applicable");
  });
});

test("mail failure after save still returns 200 and continues to the confirmation", async () => {
  await withoutServiceEnv(async () => {
    const collection = memoryCollection();
    let confirmations = 0;
    const response = await POST({ request: requestFor(bookDemoPayload()) }, {
      getSubmissionCollection: async () => collection,
      isZoomSchedulerEnabled: () => false,
      sendSubmissionEmail: async () => {
        throw new Error("Missing host mail configuration.");
      },
      sendMeetingScheduledEmail: async () => {
        confirmations += 1;
        return mailSuccess("Your Swishtag demo is scheduled");
      },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.message, "Thanks. Your request has been saved and sent to Swishtag.");
    assert.equal(body.warning, "Your request was saved. Some follow-up messages could not be sent.");
    assert.equal(confirmations, 1);
    assert.equal(collection.rows[0].emailStatus, "failed");
    assert.equal(collection.rows[0].meetingConfirmationStatus, "sent");
  });
});

test("Zoom failure after save still returns 200 and sends both emails without a join link", async () => {
  await withoutServiceEnv(async () => {
    const collection = memoryCollection();
    let notifiedMeeting = "unset";
    const calls = { notify: 0, confirm: 0 };
    const response = await POST({ request: requestFor(bookDemoPayload()) }, {
      getSubmissionCollection: async () => collection,
      isZoomSchedulerEnabled: () => true,
      createZoomMeetingForSubmission: async () => {
        throw new Error("Missing accountId Zoom configuration.");
      },
      sendSubmissionEmail: async document => {
        calls.notify += 1;
        notifiedMeeting = document.zoomMeeting;
        return mailSuccess("New book demo request");
      },
      sendMeetingScheduledEmail: async () => {
        calls.confirm += 1;
        return mailSuccess("Your Swishtag demo is scheduled");
      },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.warning, "Your request was saved. Some follow-up messages could not be sent.");
    assert.equal(calls.notify, 1);
    assert.equal(calls.confirm, 1);
    assert.equal(notifiedMeeting, null);
    assert.equal(collection.rows[0].zoomStatus, "failed");
    assert.equal(collection.rows[0].emailStatus, "sent");
    assert.equal(collection.rows[0].meetingConfirmationStatus, "sent");
  });
});

test("a taken book-demo slot returns 409 and does not send mail", async () => {
  await withoutServiceEnv(async () => {
    const payload = bookDemoPayload();
    const collection = memoryCollection([{
      _id: "1",
      formType: "book-demo",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      meetingAt: new Date(payload.selectedSlotUtc),
      meetingAtISO: payload.selectedSlotUtc,
      fields: { selectedSlotUtc: payload.selectedSlotUtc },
    }]);
    let notifications = 0;
    const response = await POST({ request: requestFor(payload) }, {
      getSubmissionCollection: async () => collection,
      isZoomSchedulerEnabled: () => true,
      sendSubmissionEmail: async () => {
        notifications += 1;
        return mailSuccess("should not send");
      },
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.equal(body.ok, false);
    assert.equal(body.code, "slot_taken");
    assert.equal(notifications, 0);
    assert.equal(collection.rows.length, 1);
  });
});

test("missing database configuration returns JSON instead of throwing", async () => {
  await withoutServiceEnv(async () => {
    const response = await POST({ request: requestFor(bookDemoPayload()) });
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.equal(body.ok, false);
    assert.match(body.message, /form database is not configured/i);
    assert.equal(typeof body.requestId, "string");
  });
});

test("missing Zoom and mail configuration is recorded and still returns 200", async () => {
  await withoutServiceEnv(async () => {
    process.env.ZOOM_ENABLED = "true";
    const collection = memoryCollection();
    const response = await POST({ request: requestFor(bookDemoPayload()) }, {
      getSubmissionCollection: async () => collection,
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.warning, "Your request was saved. Some follow-up messages could not be sent.");
    assert.equal(collection.rows[0].zoomStatus, "failed");
    assert.match(collection.rows[0].zoomError, /Zoom/i);
    assert.equal(collection.rows[0].emailStatus, "failed");
    assert.equal(collection.rows[0].meetingConfirmationStatus, "failed");
  });
});

test("a status update failure after save does not become a 500", async () => {
  await withoutServiceEnv(async () => {
    const collection = memoryCollection();
    collection.failUpdates = true;
    const response = await POST({ request: requestFor(bookDemoPayload()) }, {
      getSubmissionCollection: async () => collection,
      isZoomSchedulerEnabled: () => false,
      sendSubmissionEmail: async () => mailSuccess("New book demo request"),
      sendMeetingScheduledEmail: async () => mailSuccess("Your Swishtag demo is scheduled"),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(collection.rows.length, 1);
  });
});

test("availability and location endpoints work with service env unset", async () => {
  await withoutServiceEnv(async () => {
    const availability = await getAvailability();
    assert.equal(availability.status, 200);
    assert.deepEqual(await availability.json(), {
      ok: true,
      busy: [],
      degraded: true,
    });

    const countriesResponse = await getCountries();
    const countries = await countriesResponse.json();
    assert.equal(countriesResponse.status, 200);
    assert.equal(countries.ok, true);
    assert.ok(countries.countries.some(country => country.code === "US"));

    const citiesResponse = await getCities({
      url: new URL("http://localhost/api/locations/cities?country=US&q=Austin,%20Texas"),
    });
    const cities = await citiesResponse.json();
    assert.equal(citiesResponse.status, 200);
    assert.equal(cities.cities.find(city => city.label === "Austin, Texas").timezone, "America/Chicago");
  });
});
