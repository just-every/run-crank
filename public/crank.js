// The server renders a readable UTC time for no-JavaScript clients. In a browser
// the same timestamp is shown in the viewer's zone, US style ("Oct 14, 2026, 9:12 AM"),
// or as a clock time ("9:12 AM") where the page marks it data-format="clock" and the time is
// from today in the viewer's zone (any other day keeps its date).
const formats = {
  date: new Intl.DateTimeFormat('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }),
  clock: new Intl.DateTimeFormat('en-US', { hour:'numeric', minute:'2-digit' }),
};
const full = new Intl.DateTimeFormat('en-US', { dateStyle:'full', timeStyle:'long' });
for (const time of document.querySelectorAll('time[datetime]')) {
  const date = new Date(time.dateTime);
  if (!Number.isNaN(date.getTime())) {
    const format = time.dataset.format === 'clock' && date.toDateString() !== new Date().toDateString() ? 'date' : time.dataset.format;
    time.textContent = (formats[format] ?? formats.date).format(date);
    time.title = full.format(date);
  }
}
