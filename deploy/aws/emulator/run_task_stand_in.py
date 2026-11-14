"""Stands in for deploy/aws/lambda/run-task/run_task.py in run.sh's work copy.

The deploy task cannot run in AWS Emulator: the emulator's Lambda runtime has
no ECS client, and it runs no containers. This checks the invocation carries
what the real handler needs and answers as it does when the task exits 0, so
the apply goes on to what waits for the deploy (the app's services).
"""


def handler(event, context):
    for key in ("cluster", "task_definition", "subnets", "security_groups", "container"):
        if not event.get(key):
            raise ValueError(f"the deploy invocation has no {key}")
    if not str(event["task_definition"]).startswith("arn:aws:ecs:"):
        raise ValueError(f"task_definition is not a task definition ARN: {event['task_definition']}")
    return {"task_arn": "emulated: the deploy task did not run", "exit_code": 0}
