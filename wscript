#
# Pebble application build rules.
#
top = '.'
out = 'build'


def check_watch_symbols(task):
    import subprocess
    symbols = subprocess.check_output(task.env.NM + [task.inputs[0].abspath()],
                                      universal_newlines=True)
    unsafe = {'_impure_ptr', '_impure_data', '__errno', '_ctype_', '__sf', '_sbrk'}
    found = sorted({line.split()[-1] for line in symbols.splitlines() if line.split()} & unsafe)
    if found:
        task.generator.bld.fatal('Unsafe newlib state in relocated watchapp: ' + ', '.join(found))
    header = [line.split() for line in symbols.splitlines() if line.split() and line.split()[-1] == '__pbl_app_info']
    if len(header) != 1 or int(header[0][0], 16) != 0:
        task.generator.bld.fatal('Missing or misplaced Pebble app header')
    task.outputs[0].write('No unsupported newlib state symbols\n')


def options(ctx):
    ctx.load('pebble_sdk')


def configure(ctx):
    ctx.load('pebble_sdk')
    ctx.pbl_suppress_newer_gcc_warnings()
    ctx.find_program('arm-none-eabi-nm', var='NM')


def build(ctx):
    ctx.load('pebble_sdk')

    binaries = []
    cached_env = ctx.env
    for platform in ctx.env.TARGET_PLATFORMS:
        ctx.env = ctx.all_envs[platform]
        ctx.set_group(ctx.env.PLATFORM_NAME)
        app_elf = '{}/pebble-app.elf'.format(ctx.env.BUILD_DIR)
        ctx.pbl_build(source=ctx.path.ant_glob('src/c/**/*.c'),
                      target=app_elf,
                      bin_type='app')
        check = ctx(rule=check_watch_symbols, source=app_elf,
                    target=app_elf + '.symbols-ok')
        check.env.NM = cached_env.NM
        binaries.append({'platform': platform, 'app_elf': app_elf})

    ctx.env = cached_env
    ctx.set_group('bundle')
    ctx.env.BUNDLE_NAME = 'codey.pbw'
    ctx.pbl_bundle(binaries=binaries,
                   js=ctx.path.ant_glob(['src/pkjs/**/*.js',
                                         'src/common/**/*.js']),
                   js_entry_file='src/pkjs/index.js')
