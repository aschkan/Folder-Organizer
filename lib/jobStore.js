'use strict';

const jobs = new Map();

function createJob(job) {
  jobs.set(job.id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id);
}

function deleteJob(id) {
  jobs.delete(id);
}

module.exports = { jobs, createJob, getJob, deleteJob };
