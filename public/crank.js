// The server renders a readable UTC time for no-JavaScript clients. In a browser
// the same timestamp is shown in the viewer's zone, US style ("Oct 14, 2026, 9:12 AM"),
// or as a clock time ("9:12 AM") where the page marks it data-format="clock".
const formats = {
  date: new Intl.DateTimeFormat('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }),
  clock: new Intl.DateTimeFormat('en-US', { hour:'numeric', minute:'2-digit' }),
};
const full = new Intl.DateTimeFormat('en-US', { dateStyle:'full', timeStyle:'long' });
for (const time of document.querySelectorAll('time[datetime]')) {
  const date = new Date(time.dateTime);
  if (!Number.isNaN(date.getTime())) {
    time.textContent = (formats[time.dataset.format] ?? formats.date).format(date);
    time.title = full.format(date);
  }
}
