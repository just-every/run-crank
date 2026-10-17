// The server renders a readable UTC time for no-JavaScript clients. In a browser
// the same timestamp is shown in the viewer's zone, US style ("Oct 14, 2026, 9:12 AM").
const format = new Intl.DateTimeFormat('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' });
for (const time of document.querySelectorAll('time[datetime]')) {
  const date = new Date(time.dateTime);
  if (!Number.isNaN(date.getTime())) {
    time.textContent = format.format(date);
    time.title = new Intl.DateTimeFormat('en-US', { dateStyle:'full', timeStyle:'long' }).format(date);
  }
}
