// Mobile charts use the same UTC axis in every panel. Times are Unix seconds,
// matching the forecast domain; local daylight-saving changes must not move it.
const HOUR = 3600;
const DAY = 24 * HOUR;
const STEPS = [1, 2, 3, 6, 12, 24, 48, 72, 96, 168];
const weekday = new Intl.DateTimeFormat('en-GB', {weekday: 'short', timeZone: 'UTC'});
const dateLabel = new Intl.DateTimeFormat('en-GB', {day: '2-digit', month: 'short', timeZone: 'UTC'});

export const MOBILE_AXIS_BOTTOM = 54;

function alignedTimes(start, end, step) {
  const times = [];
  for (let t = Math.ceil(start / step) * step; t <= end && times.length < 600; t += step) times.push(t);
  return times;
}

/**
 * Build the phone axis without reading browser state. The plot's left and right
 * margins leave room to centre labels at both edges; shifting the final label
 * inward would make it collide with the preceding date on a small screen.
 * Inline SVG styles are intentional: saved PNG/SVG images retain the same axis.
 */
export function buildMobileTimeAxis({start, end, width, height, left = 38, right = 53, top = 11}) {
  const plotWidth = width - left - right;
  const empty = {bottom: MOBILE_AXIS_BOTTOM, ticks: [], hourTicks: [], gridTimes: [], markup: ''};
  if (![start, end, width, height, left, right, top].every(Number.isFinite) || end <= start || plotWidth <= 0 || height <= top + MOBILE_AXIS_BOTTOM) return empty;

  const span = end - start;
  // Full stacked dates need about 42px rather than the previous 100px.
  // A five-day view therefore retains a date for every day even on a 320px phone.
  const capacity = Math.max(1, Math.floor(plotWidth / 42));
  const dailyWidth = plotWidth * DAY / span;
  const compactDaily = span >= 2 * DAY && span <= 8 * DAY && dailyWidth >= 24 && dailyWidth < 42;
  const tickHours = compactDaily ? 24 : STEPS.find(hours => span / (hours * HOUR) <= capacity) ?? 168;
  const step = tickHours * HOUR;
  // On the narrowest phones a week can still show every weekday and day number.
  // Its month and exact endpoints remain explicit in the panel's UTC window row.
  const labelWidth = compactDaily ? 24 : 42;
  const x = time => left + (time - start) / span * plotWidth;
  const plotBottom = height - MOBILE_AXIS_BOTTOM;
  const dayY = plotBottom + 15, dateY = plotBottom + 29, timeY = plotBottom + 43;
  const ticks = alignedTimes(start, end, step).map(time => {
    const date = new Date(time * 1000), pos = x(time);
    return {
      time,
      x: pos,
      day: weekday.format(date),
      date: compactDaily ? String(date.getUTCDate()).padStart(2, '0') : dateLabel.format(date),
      clock: String(date.getUTCHours()).padStart(2, '0') + 'Z',
      left: pos - labelWidth / 2,
      right: pos + labelWidth / 2
    };
  });

  // Keep a midnight guide for every day, including long windows where labels
  // themselves must skip days. Sub-day zooms gain 6/12-hour (or finer) guides.
  const gridTimes = alignedTimes(start, end, Math.min(DAY, step));
  const showHalfDays = tickHours === 24 && plotWidth * 12 * HOUR / span >= 23;
  const hourTicks = showHalfDays
    ? alignedTimes(start, end, 12 * HOUR).filter(time => time % DAY !== 0).map(time => ({time, x: x(time), clock: '12Z'}))
    : [];
  const pos = n => Number(n.toFixed(3));

  let markup = '<g class="mobile-time-axis">';
  for (const time of gridTimes) {
    const isDay = time % DAY === 0, px = pos(x(time));
    markup += `<line class="gridline ${isDay ? 'day-grid' : 'hour-grid'}" data-time="${time}" x1="${px}" x2="${px}" y1="${top}" y2="${plotBottom}" style="stroke:var(--${isDay ? 'border' : 'grid'});stroke-width:1;stroke-opacity:${isDay ? '.7' : '.65'}"/>`;
  }
  for (const tick of ticks) {
    const px = pos(tick.x);
    markup += `<line class="date-mark" x1="${px}" x2="${px}" y1="${plotBottom}" y2="${plotBottom + 4}" style="stroke:var(--muted);stroke-width:1"/>`;
    markup += `<text class="date-tick" data-time="${tick.time}" x="${px}" text-anchor="middle" style="fill:var(--ink);font-size:11px;font-weight:600;letter-spacing:-.15px"><tspan class="tick-weekday" x="${px}" y="${dayY}"${compactDaily ? ' style="font-size:10px"' : ''}>${tick.day}</tspan><tspan class="tick-date" x="${px}" y="${dateY}" style="font-weight:700">${tick.date}</tspan><tspan class="tick-clock" x="${px}" y="${timeY}" style="fill:var(--muted);font-size:10px;font-weight:500;letter-spacing:0">${tick.clock}</tspan></text>`;
  }
  for (const tick of hourTicks) {
    const px = pos(tick.x);
    markup += `<line class="hour-mark" x1="${px}" x2="${px}" y1="${plotBottom}" y2="${plotBottom + 3}" style="stroke:var(--muted);stroke-width:1;stroke-opacity:.6"/><text class="time-tick" data-time="${tick.time}" x="${px}" y="${timeY}" text-anchor="middle" style="fill:var(--muted);font-size:10px;font-weight:500">${tick.clock}</text>`;
  }
  markup += '</g>';
  return {bottom: MOBILE_AXIS_BOTTOM, tickHours, compact: compactDaily, ticks, hourTicks, gridTimes, markup};
}
