// The server renders a readable UTC time for no-JavaScript clients. In a browser
// the same timestamp is shown in the viewer's zone, preserving its raw datetime.
const format = new Intl.DateTimeFormat('en-CA', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
for (const time of document.querySelectorAll('time[datetime]')) {
  const date = new Date(time.dateTime);
  if (!Number.isNaN(date.getTime())) {
    const parts = Object.fromEntries(format.formatToParts(date).map(part => [part.type, part.value]));
    time.textContent = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
    time.title = new Intl.DateTimeFormat(undefined, { dateStyle:'full', timeStyle:'long' }).format(date);
  }
}
