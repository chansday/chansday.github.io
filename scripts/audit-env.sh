# Sourced by Bash for workflow run steps, after checkout. GitHub does not allow
# setting NODE_OPTIONS through GITHUB_ENV, so set it inside the shell instead.
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=${GITHUB_WORKSPACE}/providers/request-audit.js"
