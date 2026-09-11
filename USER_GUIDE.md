# PMS Portal — Guide for Rig Crews

This covers the daily job: download the template, fill it in, upload it. It takes about five minutes
a day.

---

## The daily cycle

1. At the end of each day, record every machine's hours in the Daily Mechanical Report workbook.
2. The next morning, upload the workbook to the portal.
3. The portal updates each machine's running hours and works out how long until its next service.

## 1. Getting the workbook

You only need to do this once a month.

1. Sign in and open **Mechanical Logs**.
2. Choose your rig and the month.
3. Press **Download template**.

You get a file named like `Mechanical_Log_Sheet_Rig_50-01_August_2026.xlsx`. It has 31 sheets, one
per day, already carrying:

- your rig number and the date on each sheet,
- every machine registered against your rig, with its make, serial number and service interval,
- each machine's current meter reading on day 1,
- all the formulas.

Save it somewhere you will find it again. Use the same file all month.

## 2. Filling it in

Open the sheet for the day. Type into these columns only:

| Column | What goes in it |
| --- | --- |
| E — Is in Use | Yes or No |
| F — Hours Run DAY | Hours the machine ran on the day shift |
| G — Hours Run NIGHT | Hours it ran on the night shift |
| H — Lube Oil Pressure | The reading you took |
| I — Lube Oil Added | Litres topped up |
| M — Last Service Hours | The meter reading when the machine was last serviced |
| O — Define hours | The service interval, e.g. 500 |
| Q, R, S | Maintenance details, remarks, and the date of the last service |

Columns J, K, L, N and P fill themselves in and are locked. So are the rig number and the date. If
Excel refuses to let you type in a cell, that cell is meant to be calculated — leave it alone.

Column B (Well No) is yours to set.

**Type a zero when a machine did not run.** A zero is a real observation and the portal counts it.
A blank row means "nobody looked at this machine today", and the portal skips the day entirely
rather than inventing hours for it.

### Why the numbers carry themselves forward

Each day's **Opening Running HRS** is pulled from the previous day's **Closing HRS**. That is why you
only ever type the hours run: the meter reading works its way through all 31 days on its own. If you
overwrite one of those cells the chain breaks, which is why they are locked.

## 3. Uploading

1. Open **Mechanical Logs → Upload**.
2. Drag the workbook onto the drop area, or press **browse for a file**.
3. Wait a moment while it is read. **Nothing is saved yet.**

### The preview

You will see:

- which rig the workbook was matched to,
- every machine found, and whether it is already registered or will be created,
- the new running hours, service baseline and interval each machine will be set to,
- a row of day buttons — press one to see exactly what was read for that day,
- any rows that were skipped, with the reason.

Check the day you filled in. If the numbers on screen do not match your sheet, press **Discard**,
fix the workbook and upload it again.

4. When it looks right, press **Import**.

## 4. Questions the portal may ask

These are normal. They are not errors.

**"Which rig does this workbook belong to?"**
The rig number in the workbook did not match any registered rig. Pick your rig from the list. Check
it carefully — filing a day's data against the wrong rig is not easy to undo.

**"This workbook does not end on yesterday"**
The last day you filled in is not yesterday. That usually means you are uploading an older file, or
a day was missed. The message names both dates. Continue only if that is what you intended.

**"This rig already has an upload for that day"**
Someone already uploaded data covering that day for your rig. Continuing replaces that one upload
and nothing else — every other upload for your rig stays exactly where it is.

## 5. Health checkups

Every machine is also inspected on a calendar schedule, normally every 90 days. Open
**Healthcheckup** and either:

- **Manual Entry** — for a single machine: pick it, set the date, mark it Normal or Breakdown, add
  your name and what you found, then save; or
- **Excel Upload** — download the health checkup template for your rig, fill in the condition and
  findings for each machine, and upload it the same way as a mechanical log.

Logging a checkup resets that machine's countdown. Marking a machine as Breakdown flags it on the
dashboard immediately.

## 6. Checking your own rig

- **PMS Dashboard** — the Upload Status panel shows the most recent date your rig has data for. If
  it says Pending, yesterday's workbook has not arrived yet.
- **Equipment Directory** — every machine on your rig with its current hours, hours since its last
  service, and how many hours remain. Anything in amber is due within 200 hours; anything in red is
  overdue.
- **Mechanical Logs → Upload registry** — every workbook you have ever sent, and a link to download
  the original file back.

## 7. If something goes wrong

| What you see | What to do |
| --- | --- |
| "is not an Excel workbook" | Save the file as .xlsx and try again. |
| "No day worksheets were found" | The sheets must be named 1 to 31. Download a fresh template. |
| "No machine has a day with real crew data" | Nothing was typed into the hours columns. Fill the day in and re-upload. |
| A machine is missing from the preview | Its row has no hours run and no last-service figure. Fill those in. |
| The hours look far too high or too low | Check column M on your sheet — it is the meter reading at the last service, not the hours since. |
| A row was skipped | The reason is listed under the preview. Usually a blank equipment name. |

Anything else: note the file name and the exact message on screen, and send both to your maintenance
planner. The portal keeps every uploaded file, so nothing is lost while a problem is sorted out.
