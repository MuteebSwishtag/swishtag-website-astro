const SERVICE_NAMES = new Map([
  ["company-store-launch", "Shopify Company Store"],
  ["Company Store", "Shopify Company Store"],
  ["enterprise-company-store-automation", "Enterprise Company Store Automation"],
  ["Enterprise Company Store Automation", "Enterprise Company Store Automation"],
  ["not-sure-yet", "General Enquiry"],
  ["Not sure yet", "General Enquiry"],
]);

function clean(value) {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

export function demoServiceName(solutionInterest, service) {
  const interest = clean(solutionInterest);
  const slug = clean(service);
  return SERVICE_NAMES.get(slug) || SERVICE_NAMES.get(interest) || interest || "General Enquiry";
}

export function demoTitle(solutionInterest, service) {
  const name = demoServiceName(solutionInterest, service);
  return name.endsWith(" Demo") ? name : `${name} Demo`;
}

export function buildZoomAgenda({ serviceName, notes, meetingTime, limit = 2000 } = {}) {
  const serviceLine = `Service: ${clean(serviceName) || "General Enquiry"}`;
  const timeLine = `Meeting time: ${clean(meetingTime)}`;
  const noteText = clean(notes);
  const notesLabel = "Notes: ";
  const reserved = serviceLine.length + notesLabel.length + timeLine.length + 2;
  let body = noteText;
  if (reserved + body.length > limit) {
    const room = Math.max(0, limit - reserved - 1);
    body = room ? `${body.slice(0, room).trimEnd()}…` : "";
  }
  const agenda = [serviceLine, `${notesLabel}${body || "-"}`, timeLine].join("\n");
  return agenda.length <= limit ? agenda : agenda.slice(0, limit);
}
