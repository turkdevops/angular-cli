import { join } from 'path';
import { getGlobalVariable } from '../../utils/env';
import { writeFile } from '../../utils/fs';
import { installPackage, uninstallPackage } from '../../utils/packages';
import { ng } from '../../utils/process';
import { updateJsonFile } from '../../utils/project';
import { expectToFail } from '../../utils/utils';
import { readNgVersion } from '../../utils/version';

export default async function() {
  // Setup an i18n enabled component
  await ng('generate', 'component', 'i18n-test');
  await writeFile(
    join('src/app/i18n-test', 'i18n-test.component.html'),
    '<p i18n>Hello world</p>',
  );

  // Should fail if `@angular/localize` is missing
  const { message: message1 } = await expectToFail(() => ng('extract-i18n'));
  if (!message1.includes(`Ivy extraction requires the '@angular/localize' package.`)) {
    throw new Error('Expected localize package error message when missing');
  }

  // Install correct version
  let localizeVersion = '@angular/localize@' + readNgVersion();
  if (getGlobalVariable('argv')['ng-snapshots']) {
    localizeVersion = require('../../ng-snapshot/package.json').dependencies['@angular/localize'];
  }
  await installPackage(localizeVersion);

  // Should not show any warnings when extracting
  const { stderr: message5 } = await ng('extract-i18n');
  if (message5.includes('WARNING')) {
    throw new Error('Expected no warnings to be shown');
  }

  // Disable Ivy
  await updateJsonFile('tsconfig.json', config => {
    const { angularCompilerOptions = {} } = config;
    angularCompilerOptions.enableIvy = false;
    config.angularCompilerOptions = angularCompilerOptions;
  });

  // Should show ivy disabled application warning with enableIvy false
  const { stderr: message4 } = await ng('extract-i18n');
  if (!message4.includes(`Ivy extraction enabled but application is not Ivy enabled.`)) {
    throw new Error('Expected ivy disabled application warning');
  }

  await uninstallPackage('@angular/localize');
}
