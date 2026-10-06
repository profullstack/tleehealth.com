/**
 * A demo front-desk day. Every response says `demo: true`; nothing here is a
 * real patient. It exists so every surface is built against the real shape.
 */
const ROWS = [
  ['08:30', 'Mission St', 'Dr. Okafor', 'Patient A.', 'New patient', 'video', 'confirmed'],
  ['09:00', 'Mission St', 'Dr. Okafor', 'Patient B.', 'Follow-up', 'in person', 'confirmed'],
  ['09:30', 'Valencia', 'NP Reyes', 'Patient C.', 'Refill review', 'video', 'calling'],
  ['10:15', 'Valencia', 'NP Reyes', 'Patient D.', 'Lab results', 'in person', 'rescheduled'],
  ['11:00', 'Mission St', 'Dr. Okafor', 'Patient E.', 'Annual', 'in person', 'unconfirmed'],
  ['13:30', 'Valencia', 'Dr. Lin', 'Patient F.', 'Follow-up', 'video', 'confirmed'],
];

export function demoDay(date) {
  return {
    demo: true,
    date,
    locations: ['Mission St', 'Valencia'],
    appointments: ROWS.map(([time, location, provider, patient, type, mode, call], i) => ({
      id: `demo-${i + 1}`,
      start: `${date}T${time}:00`,
      time,
      location,
      provider,
      patient,
      type,
      mode,
      reminder_call: call,
    })),
  };
}
