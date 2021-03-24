import { expectFileToMatch, replaceInFile, writeMultipleFiles } from '../../../utils/fs';
import { ng } from '../../../utils/process';

export default async function () {
  await writeMultipleFiles({
    'src/styles.css': `a {
        all: initial;
     }`,
  });

  // Enable IE 11 support
  await replaceInFile(
    '.browserslistrc',
    'not IE 11',
    'IE 11',
  );

  await ng('build', '--configuration=development');
  await expectFileToMatch('dist/test-project/styles.css', 'z-index: auto');
  await expectFileToMatch('dist/test-project/styles.css', 'all: initial');
}
