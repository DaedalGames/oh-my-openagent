import { packageName as sdkPackageName } from "@oh-my-opencode/omo-computer-sdk"

/** Relay and bunshin HandCarrier implementations of computer-use v3. */
export const packageName = "@oh-my-opencode/omo-computer-carriers" as const

/** The packages this one depends on, exactly the edges of the architecture table. */
export const dependencyPackageNames = [sdkPackageName] as const
