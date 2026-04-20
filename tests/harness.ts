type TestCase = {
  name: string;
  fn: () => void | Promise<void>;
};

const testCases: TestCase[] = [];

export function test(name: string, fn: () => void | Promise<void>): void {
  testCases.push({ name, fn });
}

export async function runRegisteredTests(): Promise<void> {
  let failed = 0;

  for (const testCase of testCases) {
    try {
      await testCase.fn();
      console.log(`PASS ${testCase.name}`);
    } catch (error) {
      failed += 1;
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`FAIL ${testCase.name}`);
      console.error(detail);
    }
  }

  if (failed > 0) {
    throw new Error(`${failed} test(s) failed.`);
  }
}
