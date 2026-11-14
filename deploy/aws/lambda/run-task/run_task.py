"""Run one ECS task to completion and say how it ended (deploy/aws).

Terraform invokes this (aws_lambda_invocation) to run the database migrations
as a one-off task before any service is updated: an apply fails when the
migrations fail, and nothing new starts on a schema it does not know.

Event: {cluster, task_definition, subnets, security_groups, container, timeout_s}
Answer: {task_arn, exit_code}, or an exception (which fails the apply) with the
container's reason and its last log lines.
"""

import time

import boto3

ecs = boto3.client("ecs")
logs = boto3.client("logs")


def last_lines(task, container, n=25):
    """The container's last log lines, when its task definition sends them to CloudWatch."""
    td = ecs.describe_task_definition(taskDefinition=task["taskDefinitionArn"])["taskDefinition"]
    for c in td["containerDefinitions"]:
        cfg = (c.get("logConfiguration") or {}).get("options") or {}
        if c["name"] == container and "awslogs-group" in cfg:
            stream = f"{cfg['awslogs-stream-prefix']}/{container}/{task['taskArn'].rsplit('/', 1)[1]}"
            try:
                events = logs.get_log_events(
                    logGroupName=cfg["awslogs-group"], logStreamName=stream, limit=n, startFromHead=False
                )["events"]
                return [e["message"] for e in events]
            except logs.exceptions.ResourceNotFoundException:
                return []
    return []


def handler(event, context):
    started = ecs.run_task(
        cluster=event["cluster"],
        taskDefinition=event["task_definition"],
        launchType="FARGATE",
        count=1,
        startedBy="terraform-migrate",
        networkConfiguration={
            "awsvpcConfiguration": {
                "subnets": event["subnets"],
                "securityGroups": event["security_groups"],
                "assignPublicIp": "DISABLED",
            }
        },
    )
    if not started.get("tasks"):
        raise RuntimeError(f"ECS did not start the task: {started.get('failures')}")
    arn = started["tasks"][0]["taskArn"]
    # Leave a minute of the Lambda's own 15 for saying how it went.
    deadline = time.time() + min(int(event.get("timeout_s", 780)), context.get_remaining_time_in_millis() / 1000 - 60)
    task = started["tasks"][0]
    while time.time() < deadline:
        time.sleep(10)
        task = ecs.describe_tasks(cluster=event["cluster"], tasks=[arn])["tasks"][0]
        if task["lastStatus"] == "STOPPED":
            break
    else:
        ecs.stop_task(cluster=event["cluster"], task=arn, reason="timed out in terraform-migrate")
        raise RuntimeError(f"{arn} did not finish in time; it was stopped")

    name = event["container"]
    container = next((c for c in task["containers"] if c["name"] == name), {})
    code = container.get("exitCode")
    if code != 0:
        lines = "\n".join(last_lines(task, name))
        raise RuntimeError(
            f"{name} in {arn} ended with {code}: {task.get('stoppedReason', '')} "
            f"{container.get('reason', '')}\n{lines}"
        )
    return {"task_arn": arn, "exit_code": code}
