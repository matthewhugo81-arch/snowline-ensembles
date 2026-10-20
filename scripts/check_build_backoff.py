"""Bound repeated automatic builds after a deterministic test failure.

Freshness checks still run. A new commit or an explicit full manual build is not
blocked, and the cooldown expires after 30 minutes. Only read-only Actions
metadata is used; an unavailable API cannot prevent publication.
"""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

COOLDOWN = timedelta(minutes=30)
TEST_STEPS = {
    'Test chart calculations and source decoder',
    'Test source index validation',
}


def parse_time(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def check_backoff(runs, load_jobs, sha, now):
    for run in runs:
        if run.get('head_sha') != sha or run.get('conclusion') != 'failure':
            continue
        retry_at = parse_time(run['updated_at']) + COOLDOWN
        if retry_at <= now:
            continue
        for job in load_jobs(run['id']):
            if job.get('name') != 'build':
                continue
            for step in job.get('steps', []):
                if step.get('name') in TEST_STEPS and step.get('conclusion') == 'failure':
                    return {'blocked': True, 'retry_at': retry_at.isoformat(),
                            'step': step['name'], 'run_url': run['html_url']}
    return {'blocked': False}


def main():
    repository = os.environ['GITHUB_REPOSITORY']
    token = os.environ['GH_TOKEN']
    sha = os.environ['GITHUB_SHA']

    def get(path):
        request = Request('https://api.github.com/repos/' + repository + path,
                          headers={'Authorization': 'Bearer ' + token,
                                   'Accept': 'application/vnd.github+json',
                                   'X-GitHub-Api-Version': '2022-11-28'})
        with urlopen(request, timeout=15) as response:
            return json.load(response)

    try:
        runs = get('/actions/workflows/pages.yml/runs?status=failure&per_page=10')['workflow_runs']
        result = check_backoff(runs, lambda run_id: get(f'/actions/runs/{run_id}/jobs?per_page=100')['jobs'],
                               sha, datetime.now(timezone.utc))
    except Exception as error:
        print(f'::warning::Build retry check unavailable ({type(error).__name__}); normal build remains enabled.')
        result = {'blocked': False}
    output = 'blocked=' + str(result['blocked']).lower() + '\n'
    print(output, end='')
    with Path(os.environ['GITHUB_OUTPUT']).open('a') as handle:
        handle.write(output)
    if result['blocked']:
        message = (f"Automatic publication is paused until {result['retry_at']} after "
                   f"[{result['step']}]({result['run_url']}) failed on this same commit. "
                   'The existing publication is retained; this run has not deployed newer data. '
                   'Fixing the commit or manually running this workflow with check_freshness disabled '
                   'bypasses the cooldown.\n')
        print(message)
        with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as handle:
            handle.write('### Automatic build retry cooldown\n\n' + message)


if __name__ == '__main__':
    main()
