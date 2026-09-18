# ADR: immutable AWS artifacts and exclusive single-controller rollout

Status: accepted for the opt-in MVP adapter.

## Context

The Relay consumer needs AWS deployment with durable encrypted state, native CLI
credentials and disposable worker instances. Existing CD builds GHCR artifacts
for other providers but has no AWS runtime contract. A host source rebuild or a
green proxy health check would not prove that the tested application artifact
and database are usable. Concurrent controllers may corrupt orchestration state.

## Decision

Keep application CloudFormation, image build/publication, domain, secrets and
migration policy in the consumer. Add a dependency-free AWS CLI engine, shared
host rollout script, composite action and reusable workflow here. AWS is off by
default; the CD lane requires explicit `target: aws`, not `all`. Consume only an
immutable digest already present in the stack's ECR repository.

Verify caller account, stack ownership, exact stack resources, encrypted attached
EBS, bootstrap completion and mounted volume serial before host mutation. Use
scoped OIDC for CI and the instance role for secret retrieval; never pass secret
values through SSM or persist an extra plaintext env file. Retain the stopped
previous Docker container to preserve its exact configuration for rollback.

Drain and stop the old controller before the new one starts. Accept bounded
downtime, verify direct app/database readiness and restore the original on
transition/readiness failures without reporting the failed release as success.
Keep SSM command handles observable; an observer timeout is not a cancelled
deployment. Provision only on an explicit request; provide no destroy command.

## Consequences

This is not HA or a multi-service orchestrator. Backward-compatible migrations,
backups and root/Docker access restrictions remain consumer responsibilities.
Nitro EBS serial verification is an intentional initial platform constraint.
Pre-release consumers must pin the tested engine SHA in both workflow and checkout
rather than relying on a major tag that does not yet contain the new adapter.
