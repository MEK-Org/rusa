import { testHostJobStoreContract } from "./host-job-store.contract.js";
import { InMemoryHostJobStore } from "./host-job-store.js";

testHostJobStoreContract("InMemoryHostJobStore", () => new InMemoryHostJobStore());
