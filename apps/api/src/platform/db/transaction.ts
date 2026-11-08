import mongoose, { type ClientSession } from "mongoose";

export async function withTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    let completed = false;
    await session.withTransaction(async () => {
      result = await work(session);
      completed = true;
    }, {
      readPreference: "primary",
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
    if (!completed) throw new Error("Transaction did not complete");
    return result;
  } finally {
    await session.endSession();
  }
}
