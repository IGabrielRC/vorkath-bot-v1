/**
 * Tool Registry: tools are the ONLY path from the router to the MOCK
 * plane. Demo tools run against canned MOCK data; future contracts
 * (searchCustomer…getInstallCode) are stubbed with no logic.
 */

export interface MockTool {
  name: string;
  description: string;
  run(args: Record<string, unknown>, userId: number): Promise<unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, MockTool>();

  register(tool: MockTool): void {
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  get(name: string): MockTool {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new Error(`unknown tool: ${name}`);
    }
    return tool;
  }

  async run(name: string, args: Record<string, unknown>, userId: number): Promise<unknown> {
    return this.get(name).run(args, userId);
  }
}
