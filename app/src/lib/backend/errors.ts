/** Errors both backends throw when a sent transaction fails, with the logs the review shows. */
import type { SimulationReport } from "@noisedlabs/sdk";

export class TransactionFailedError extends Error {
  readonly logs: string[];
  readonly errorCode: SimulationReport["errorCode"];

  constructor(message: string, logs: string[], errorCode: SimulationReport["errorCode"]) {
    super(message);
    this.name = "TransactionFailedError";
    this.logs = logs;
    this.errorCode = errorCode;
  }
}
