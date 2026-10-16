// Mail and confirmation pages describe the same configured/remaining lifetime.
export function linkExpiry(minutes) {
  if (minutes >= 1440) {
    const days = Math.ceil(minutes / 1440);
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
