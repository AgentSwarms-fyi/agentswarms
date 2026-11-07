// An AWS region, held to the shape regions have. It goes into a host name and
// into what gets signed, so the wizard and the server check it by the same rule.

export const isAwsRegion = (region: string): boolean => /^[a-z]{2}(-[a-z]+)+-\d+$/.test(region);
