from pathlib import Path
p = Path('scripts/apply-features.py')
s = p.read_text()
s = s.replace(" + attendance + needle", " + needle")
p.write_text(s)
exec(compile(s, str(p), 'exec'), {'__name__': '__main__'})
