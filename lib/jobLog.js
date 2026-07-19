'use strict';

// Keep a bounded, human-readable activity log on the job so the web panel can
// show a live feed of what the scan/move is doing right now. Bounded so a very
// large run can't grow the log without limit.
const MAX_LOG_ENTRIES = 500;

function logJob(job, msg, level = 'info') {
  if (!job) return;
  if (!Array.isArray(job.log)) job.log = [];
  job.log.push({ t: Date.now(), level, msg });
  if (job.log.length > MAX_LOG_ENTRIES) {
    job.log.splice(0, job.log.length - MAX_LOG_ENTRIES);
  }
}

module.exports = { logJob, MAX_LOG_ENTRIES };
