import { launchCopy } from '@/lib/launchCopy';

describe('launchCopy', () => {
  it('names the launch target the way each system does', () => {
    expect(launchCopy('windows')).toEqual({
      label: 'executable path',
      placeholder: 'C:\\Program Files\\...\\app.exe',
      target: 'executable',
      launchOptions: true,
    });
    expect(launchCopy('macos')).toEqual({
      label: 'app path',
      placeholder: '/Applications/YourApp.app',
      target: 'app',
      launchOptions: false,
    });
    expect(launchCopy('linux')).toEqual({
      label: 'program path',
      placeholder: '/usr/bin/your-program',
      target: 'program',
      launchOptions: false,
    });
  });

  it('reads a machine with no osFamily as windows', () => {
    expect(launchCopy(undefined)).toEqual(launchCopy('windows'));
  });
});
