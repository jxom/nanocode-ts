#hard-expand
x="a b c"; echo ${x@Q}
a=(1 "2 3"); echo ${a[@]@Q}
v=hello; echo ${v:1:-1} ${v: -3:2}
a=(a b c d); echo ${a[@]: -2:1}
a=(); a[3]=x; a[7]=y; echo ${#a[@]} ${!a[*]}
x=abcabc; echo ${x/#abc/X} ${x/%abc/Y} ${x//b}
x=Hello; echo ${x~~} ${x~}
p="*.txt"; echo ${p}
x='a*b'; case 'a*b' in $x) echo m1;; esac; case 'aXb' in "$x") echo m2;; *) echo m3;; esac
re='^[0-9]+$'; [[ 123 =~ $re ]] && echo num; [[ 123 =~ "$re" ]] || echo literal
[[ "a.b" =~ a\.b ]] && echo esc
[[ abc =~ (a)(b)(c) ]] && echo ${#BASH_REMATCH[@]} ${BASH_REMATCH[0]}
v=" a  b "; set -- $v; echo $#
IFS=, read -ra parts <<< "x,,y"; echo ${#parts[@]} "[${parts[1]}]"
IFS=: read -r a b <<< "1:2:3:4"; echo "$b"
IFS=' :' read -r a b c <<< "1 :2"; echo "[$a][$b][$c]"
x=$'a\nb\nc'; echo "${x#*$'\n'}"
unset v; echo "${v:-$(echo sub)}"
v=1; echo "${v:+$(echo alt)}"
n=3; echo ${n:-$((n+1))}
x=5; echo ${x:-${y:-z}}
echo ${#undefined}
set -- a b c; echo "${*:2}" "${@:1:1}"
a=(x y); b=("${a[@]}" z); echo ${#b[@]} "${b[*]}"
str=abc; echo ${str:5}"|"
v=10; echo $((v)) $((v+v)) $(( $v * 2 ))
echo $(( 2**63 )) $(( -2**63 ))
echo $(( 07 + 0x7 ))
x=; echo $(( x + 1 ))
echo $(( 3 / -2 )) $(( -3 % -2 ))
a=5; b=a; echo $(( b + 1 ))
echo $(( (2>1) + (1>2) ))
i=1; ((i<<=3)); echo $i
#hard-scope
f() { local v=1; g; }; g() { echo ${v:-none}; }; f; g
f() { local x; x=$1; echo $x; }; f a; echo "[${x:-}]"
x=g; f() { local x=l; unset x; echo "${x:-unset}"; }; f; echo $x
declare -n ref=target; target=42; echo $ref; ref=7; echo $target
f() { local -n r=$1; r=set; }; f out; echo $out
f() { echo "$FUNCNAME:${FUNCNAME[1]:-top}"; }; g() { f; }; g
f() { return 300; }; f; echo $?
f() { (exit 7); echo $?; }; f
f() { echo $LINENO; }; f
x=1; f() { x=2 echo; echo $x; }; f
a=1 b=2 c=$a$b; echo $c
v=outer; v=inner bash -c 'echo $v'
export -n PATH 2>/dev/null; echo ok
declare -f f >/dev/null 2>&1 || echo nofunc
f() { echo hi; }; declare -f f
f() { echo "$#:$*"; }; f "$@"; set -- 1 2; f "${@}"
f() { shift 2; echo "$@"; }; f a b c d
f() { set -- x y; echo $#; }; set -- a; f; echo $#
f() { trap 'echo ret' RETURN; :; }; f
(cd dir; echo ${PWD##*/}); echo ${PWD##*/}
x=0; for i in 1 2 3; do x=$((x+i)); done | cat; echo $x
x=0; while read i; do x=$((x+i)); done < <(seq 3); echo $x
shopt -s lastpipe; set +m; x=0; seq 3 | while read i; do x=$((x+i)); done; echo $x
#hard-redir
exec {fd}>o.txt; echo via-fd >&$fd; exec {fd}>&-; cat o.txt
{ echo a; echo b >&2; } 3>&1 1>&2 2>&3 | cat
echo x 2>&1 1>/dev/null
cat <(echo p1) <(echo p2)
echo hi > >(cat); wait; sleep 0.05
ls a.txt nope 2>&1 | sort
f() { echo out; echo err >&2; }; f 2>&1 >/dev/null | tr a-z A-Z
echo text > o.txt; cat 0<o.txt
exec 3<a.txt; read -u 3 l; read -u 3 l2; echo $l $l2; exec 3<&-
echo a > o.txt; exec 4>>o.txt; echo b >&4; exec 4>&-; cat o.txt
(echo sub-out; echo sub-err >&2) 2>&1 | wc -l
echo $( { echo a; echo b >&2; } 2>&1 ) 
printf 'x' > o.txt; printf 'y' >> o.txt; cat o.txt; echo
echo hi 1>o.txt 1>p.txt; cat o.txt; cat p.txt
cat < nonexist; echo $?
echo > "sp ace.txt" x; ls sp*
read l < a.txt; echo $l
#hard-heredoc
<<<
for i in 1 2; do
cat <<EOF
it $i
EOF
done
>>>
<<<
cat <<EOF
$(echo cmd) \$(echo no) \`echo bt\`
EOF
>>>
<<<
cat << 'X Y'
spaced
X Y
>>>
<<<
cat <<EOF | sed 's/^/> /'
a
b
EOF
>>>
<<<
x=$(cat <<'EOF'
'single' "double" $none
EOF
)
echo "$x"
>>>
<<<
cat <<EOF
${HOME:+home-set}
EOF
>>>
<<<
if true; then
	cat <<-END
		indented
	END
fi
>>>
<<<
cat <<EOF >o.txt
to-file
EOF
cat o.txt
>>>
<<<
f() {
  cat <<EOF
in-func $1
EOF
}
f arg
>>>
#hard-control
case abc in *b*) echo has-b;;& *c) echo has-c;; esac
case "$undefined" in "") echo empty;; esac
for i in a b; do :; done; echo $i
for ((;;)); do echo inf; break; done
i=0; while :; do ((i++ < 2)) || break; echo $i; done
if ! false; then echo neg; fi
if [ 1 = 1 ] && [ 2 = 2 ] || false; then echo ok; fi
[ "" ] || echo empty-false
[ -n "" ] || echo nz
[ a ] && echo nonempty-true
[ 1 -eq 01 ] && echo numeq
[[ 01 -eq 1 ]] && echo dnumeq
[[ 1+1 -eq 2 ]] && echo arith-in-dbl
[ "a" = "a" -a "b" = "b" ] && echo and
[ "a" = "b" -o "b" = "b" ] && echo or
[[ ! -e nope && -e a.txt ]] && echo combo
[[ -f a.txt || -f nope ]] && echo either
test -L a.txt || echo notlink
[ -r a.txt ] && [ -w a.txt ] && echo rw
[[ abc > abb ]] && echo gt
x=abc; [[ $x == a?c ]] && echo glob-q
[[ $x == "a?c" ]] || echo quoted-literal
until false; do echo once; break; done
for i in 1 2 3; do if [ $i = 2 ]; then break; fi; done; echo $i
while read -r a b; do echo "$b"; done <<< $'1 2\n3 4'
#hard-errexit
set -e; f() { false; echo cont; }; if f; then echo t; fi
set -e; f() { return 1; }; f && echo no; echo after
set -e; false | true; echo pipe-ok
set -e; x=1; [ $x = 2 ] && echo no; echo after-test
set -e; (( 0 )) || true; echo arith-ok
set -e; (( 0 )); echo nope
set -e; cat nonexist 2>/dev/null; echo nope
set -e; echo $(false) ok
set -e; local_x=$(false; echo ran); echo "$local_x"
set -e; f() { false; }; f; echo nope
set -e; { false; echo in-group; }; echo nope
set -e; trap 'echo exit $?' EXIT; false
set -o errexit -o nounset; echo ${U:-u}; echo $U2
set -u; a=(); echo "${a[@]}" ok
set -e; shopt -s inherit_errexit; x=$(false; echo bad); echo "[$x]"
set -euo pipefail; echo hi | grep -q zz; echo nope
trap 'echo caught-int' INT; kill -INT $$; echo after
trap 'echo t1' EXIT; trap - EXIT; echo none
trap 'echo e1' EXIT; (exit 3); echo $?
#hard-builtins
printf '%*d|%-*s|\n' 5 42 4 ab
printf '%.3d %+d % d\n' 5 5 5
printf '%s\n'
printf '%5.1f%%\n' 99.44
printf '%x %X %#x %#o\n' 255 255 255 8
printf '%s=%d\n' a 1 b 2
printf '%d\n' "'A"
printf '%d\n' abc
printf '%.0f %.0f\n' 2.5 3.5
printf '\x41\101\n'
printf '%-3s|\n' abcdef
printf '%u\n' -1
printf '%g %g %g\n' 0.0001 100000 1e20
echo -e '\e[0m' | od -c | head -1
echo -e 'a\cb'; echo after
echo -E 'a\tb'
read -n 2 x <<< abcd; echo $x
read -d , x <<< "ab,cd"; echo $x
read -r -d '' x <<< $'multi\nline'; echo "$x"
mapfile -d , -t m <<< "a,b,c"; echo ${#m[@]} "${m[2]}"
mapfile -t -s 1 -n 1 m < a.txt; echo ${m[@]}
printf -v a[2] '%s' x; echo ${a[2]}
type -a echo | head -1
type nosuch 2>/dev/null; echo $?
command echo cmd
builtin echo bi
enable -n echo 2>/dev/null; echo still
echo $- | grep -c h
set -f; echo *.txt; set +f
set -- $(echo "1 2 3"); echo $2
shopt -q extglob; echo $?
compgen -W "apple banana" -- ba
let "x = 2 * 3" "y = x + 1"; echo $x $y
echo "$( caller 2>&1; echo $? )"
times >/dev/null; echo t
ulimit -n >/dev/null; echo u
umask 022; umask
kill -0 $$ && echo alive
f() { echo "${BASH_SOURCE[0]:-none}"; }; f
echo ${BASH_VERSINFO[0]}
x=1; declare -p x
declare -r ro=1; declare -p ro
declare -ai ai=(1 2); declare -p ai
dirs | wc -w
#hard-text
sort -k2,2 -k1,1r <<< $'b 1\na 1\nc 0'
sort -s -k1,1 <<< $'b 2\na 1\nb 1'
sort -V <<< $'v1.10\nv1.2\nv1.9'
sort -f <<< $'b\nA\na\nB'
sort -n <<< $'-1\n10\n2\n1.5\nabc'
sort -g <<< $'1e3\n2\n-5'
sort -rn -t: -k2 <<< $'a:1\nb:3\nc:2'
sort -c <<< $'a\nc\nb'; echo $?
sort -o o.txt nums.txt; cat o.txt
uniq -i <<< $'a\nA\nb'
uniq -c <<< $'x\nx\ny' 
uniq -f1 <<< $'1 a\n2 a\n3 b'
cut -f2 <<< $'a\tb\tc'
cut -d' ' -f2 -s <<< $'a b\nnodelim'
cut -b2-3 <<< abcdef
cut --complement -d, -f2 data.csv
tr '[:lower:]' '[:upper:]' <<< mixedCase
tr -d '[:digit:]' <<< a1b2c3
tr -s '[:space:]' ' ' <<< $'a  \t b\n\nc'
tr 'a-c' 'x' <<< abcd
tr -cd '[:alnum:]\n' <<< 'a-b_c!1'
echo hello | tr 'elo' '310'
head -n0 a.txt; echo end
tail -n 0 a.txt; echo end
tail -n2 a.txt
head -c -3 a.txt
wc -l <<< ''
printf 'no-newline' | wc -l
wc -c <<< 'héllo'
paste - - <<< $'1\n2\n3\n4'
paste -d, a.txt <(seq 3)
nl -ba -w2 -s: <<< $'a\n\nb'
fmt -w 10 <<< 'the quick brown fox jumps'
expand -t4 <<< $'a\tb' | cat -A
unexpand -a <<< '        x' | od -c | head -1
seq 0.5 0.5 2
seq -f '%03g' 3
seq 3 -1 1
printf '%s\n' b a | sort | head -1
od -c <<< 'a b'
base64 <<< 'hello world'
base64 -w 4 <<< hello
echo aGk= | base64 --decode
md5sum <<< x
cksum <<< x
sha256sum <<< ''
xargs -n 2 <<< '1 2 3 4 5'
xargs -L1 echo L: <<< $'a b\nc'
xargs echo <<< '"a b" c'
printf 'a\nb\n' | xargs -I % sh -c 'echo [%]'
echo | xargs echo empty
xargs -r echo none < /dev/null; echo end
seq 5 | xargs -n2 -P1 echo
find dir -type f | sort | xargs -d '\n' -n1 basename
rev <<< $'abc\nde'
tac <<< $'1\n2\n3'
comm <(printf 'a\nb\n') <(printf 'b\nc\n')
join -t, <(printf 'k1,a\nk2,b\n') <(printf 'k1,x\nk3,y\n')
join -a1 <(printf '1 a\n2 b\n') <(printf '1 x\n')
csplit -s -f cs_ <(printf 'a\n--\nb\n') '/--/'; cat cs_01
#hard-grep
grep -E 'a+n' a.txt
grep -c -v '^$' <<< $'a\n\nb'
grep -o '[0-9]*' <<< 'a12b345'
grep -ob an a.txt
grep -E '\bfox\b' words.txt
grep '\<the\>' words.txt
grep -E 'o{2,}' <<< $'fo\nfoo\nfooo'
grep -i -c THE words.txt
grep -n -A1 -B1 -m1 quick words.txt
grep -L zzz a.txt words.txt
grep -r --exclude='*.md' . dir | sort
grep -rh . dir | sort
grep -c x dir/x.txt dir/z.txt
grep -E '^.{6}$' a.txt
grep -P '(?<=b)an' a.txt
grep -oP '\w+(?=,)' data.csv | head -2
grep -z -c a a.txt
grep -E '(a|b)\1' <<< $'aa\nab'
grep '\(an\)\1' a.txt
grep -E '[[:digit:]]+' data.csv | wc -l
grep --color=never an a.txt
grep -e '-x' <<< $'-x\ny'
grep -f <(echo apple) a.txt
grep -vx -f <(printf 'apple\ncherry\n') a.txt
grep -E 'a|' <<< xyz
grep '' <<< ''; echo $?
grep -E '[' a.txt; echo $?
grep -w 'an' <<< 'an ban an.'
grep -o -i 'TH.' words.txt
#hard-sed
sed -n '/^b/{p;q}' a.txt
sed '2,3s/^/#/' a.txt
sed '/apple/!s/a/A/' a.txt
sed 's/a/\n/g' <<< bab
sed 's/\t/TAB/' <<< $'a\tb'
sed -E 's/(.)/\1\1/3' <<< abc
sed 's/b*/x/2' <<< abc
sed '1d;$d' a.txt
sed -n '2{p;p}' a.txt
sed -e :a -e '$!N;s/\n//;ta' a.txt
sed 's/[^,]*,//' data.csv
sed -E 's/([a-z]+),([0-9]+)/\2-\1/' data.csv
sed '/banana/a after' a.txt
sed '/banana/i before' a.txt
sed '2r words.txt' a.txt
sed -n '/an/=' a.txt
sed 'n;d' a.txt
sed '$!d' a.txt
sed -n 'l' <<< $'a\tb'
sed 's/.*/\L&/; s/^./\u&/' <<< 'HELLO world'
sed 's/a\|e/X/g' <<< 'apple'
sed -E 's/a{2}/X/' <<< aaa
sed 's/^[[:space:]]*//' <<< '   lead'
sed 's/o/0/3g' <<< oooooo
sed -n '/^$/!p' <<< $'a\n\nb'
sed '/x/,+1d' <<< $'a\nx\nb\nc'
sed 'h;s/a/b/;x;G' <<< a
sed '=' <<< x | sed 'N;s/\n/ /'
sed --expression='s/a/b/' <<< a
sed -i.bak 's/a/b/' a.txt; cat a.txt.bak | head -1; head -1 a.txt
sed 'a\' <<< x; echo rc=$?
sed 's/x/y' <<< x; echo $?
sed -z 's/\n/,/g' a.txt
#hard-awk
awk 'BEGIN{printf "%*d|\n", 5, 3}'
awk 'BEGIN { print length() }' <<< abc
awk '{ print length() }' <<< abcd
awk 'BEGIN{CONVFMT="%.2g"; x=3.14159; y=x ""; print y}'
awk 'BEGIN{OFMT="%.2f"; print 3.14159}'
awk 'BEGIN{x; if (x == 0 && x == "") print "both"}'
awk '{ $5 = "e"; print; print NF }' <<< 'a b'
awk '{ NF = 2; print }' <<< 'a b c d'
awk -F'[,;]' '{print $2}' <<< 'a,b;c'
awk -F '\t' '{print $2}' <<< $'a\tb c'
awk 'BEGIN{FS=""} {print $2}' <<< abc
awk '{print $1}' FS=, data.csv | head -2
awk 'BEGIN{a["x"]; if ("x" in a) print "in"; delete a["x"]; if (!("x" in a)) print "out"}'
awk 'BEGIN{split("c b a", arr); asort(arr); print arr[1]}'
awk 'BEGIN{print substr("hello", -1, 3)}'
awk 'BEGIN{print index("abc", "")}'
awk 'BEGIN{s="aaa"; n=gsub(/a/, "&&", s); print n, s}'
awk 'BEGIN{s="a.b"; gsub(".", "x", s); print s}'
awk 'BEGIN{s="path/to"; gsub("/", "\\/", s); print s}'
awk 'BEGIN{print match("xxabc", "ab"), RSTART}'
awk 'BEGIN{printf "%s %s\n", "only"}'
awk 'BEGIN{printf "%d %d\n", "3abc", -2.7}'
awk 'BEGIN{print 10 % 3.5, 2 ** 3}'
awk 'BEGIN{print 1==1.0, "1"==1, "a"<"b"}'
awk 'BEGIN{x = 1; x += x++; print x}'
awk '{ getline line < "a.txt"; print $0, line }' <<< $'1\n2'
awk 'BEGIN{while ((getline l < "a.txt") > 0) n++; print n}'
awk 'BEGIN{cmd="sort -r a.txt"; while ((cmd | getline l) > 0) print l; close(cmd)}'
awk '{print | "sort -r"}' a.txt
awk 'BEGIN{print "err" > "/dev/stderr"}' 2>&1
awk 'BEGIN{system("echo sys"); print "after"}'
awk 'BEGIN{exit 3}'; echo $?
awk 'END{print $0}' a.txt
awk 'BEGIN{n=split("a1b2c", arr, /[0-9]/); print n, arr[2]}'
awk '/apple/,/banana/' a.txt
awk 'BEGIN{RS=","} {print}' <<< 'a,b,c'
awk 'BEGIN{ORS="|"} {print}' a.txt; echo
awk 'NR==FNR{a[$1];next} $1 in a' <(echo banana) a.txt
awk '{$0="x y"; print $2}' <<< z
awk 'BEGIN{printf("%5.1e\n", 12345)}'
awk 'BEGIN{print toupper(substr("hello",1,1)) substr("hello",2)}'
awk 'BEGIN { srand(1); r = rand(); print (r >= 0 && r < 1) }'
awk -v 's=a\tb' 'BEGIN{print s}'
awk 'BEGIN{print ARGV[1]}' foo
awk '{print}' ENVIRON_TEST=1 a.txt | head -1
awk 'BEGIN{print ENVIRON["HOME"] != ""}'
awk 'BEGIN { print 017, 0x11 }'
awk 'BEGIN { x["a"]=1; x["b"]=2; delete x; print length(x) }'
awk 'BEGIN { print substr("abc", 2, 100) "|" }'
awk 'BEGIN { print 100000 * 100000, 2^53 + 1 }'
awk 'BEGIN { printf "%.10g\n", 1/3 }'
awk 'BEGIN { print -0 }'
awk '{ printf "%-10s|%5s\n", $1, $2 }' words.txt
awk 'BEGIN{a="10"; b="9"; print (a<b)}'
awk '{print ($1 < $2)}' <<< '10 9'
#hard-jq
jq -r '@sh' <<< '["a b", "c'"'"'d"]'
jq -r '@json' <<< '{"a":"x"}'
jq -r '@uri' <<< '"a b&c"'
jq -r '@html' <<< '"<a>"'
jq -R . <<< 'raw line'
jq -Rs . <<< $'l1\nl2'
jq -n 'input' <<< '1 2'
jq -n '[inputs]' -c <<< '1 2 3'
jq -c '.[1:]' <<< '[1,2,3]'
jq -c '.[-1:]' <<< '[1,2,3]'
jq -r '.[] | tostring' <<< '[1,"a",null,true]'
jq -c 'map(type)' <<< '[1,"a",null,true,[],{}]'
jq 'length' <<< '"héllo"'
jq 'utf8bytelength' <<< '"héllo"'
jq -c 'to_entries' <<< '{"a":1}'
jq -c 'from_entries' <<< '[{"key":"a","value":1}]'
jq -c '. as [$a, $b] | {a: $a, b: $b}' <<< '[1,2]'
jq -c '.[] as {n: $n} | $n' <<< '[{"n":1}]'
jq -c 'path(..)' <<< '{"a":[1]}'
jq -c 'getpath(["a","b"])' <<< '{"a":{"b":5}}'
jq -c 'setpath(["a"]; 1)' <<< '{}'
jq -c 'del(.[0])' <<< '[1,2]'
jq -c 'to_entries | map(select(.value > 1)) | from_entries' <<< '{"a":1,"b":2}'
jq -c '[.[] | ascii_downcase]' <<< '["A","b"]'
jq -c 'ltrimstr("a") , rtrimstr("c")' <<< '"abc"'
jq -c 'startswith("a"), endswith("x")' <<< '"abc"'
jq -c 'indices(", ")' <<< '"a, b, c"'
jq -c '[match("a+"; "g") | .string]' <<< '"aa b aaa"'
jq -c 'capture("(?<x>[0-9]+)")' <<< '"ab12"'
jq -c '[scan("[0-9]")]' <<< '"a1b2"'
jq -c 'gsub("a"; "b")' <<< '"aaa"'
jq -c 'ascii' <<< 65 2>/dev/null || echo noascii
jq -c 'implode' <<< '[104,105]'
jq -c 'explode' <<< '"hi"'
jq -c 'tojson, (tojson|fromjson)' <<< '{"a":[1]}'
jq -c 'min_by(.x), max_by(.x)' <<< '[{"x":2},{"x":1}]'
jq -c 'unique_by(length)' <<< '["a","b","cc"]'
jq -c 'group_by(.k) | map({k: .[0].k, n: length})' <<< '[{"k":1},{"k":2},{"k":1}]'
jq -c 'reverse' <<< '[1,2,3]'
jq -c 'contains(["b"])' <<< '["abc"]'
jq -c 'inside({"a":1,"b":2})' <<< '{"a":1}'
jq -c 'index("b")' <<< '"abc"'
jq -c 'combinations' <<< '[[1,2],[3]]'
jq -c 'walk(if type == "number" then . + 1 else . end)' <<< '[1,[2]]'
jq -c 'env | type'
jq -c '$ENV | type'
jq -c 'splits("a")' <<< '"bab"'
jq -c 'ascii_upcase' <<< '"é"'
jq -c '.a?' <<< '[1]'
jq -c 'try error("x") catch .' <<< null
jq -c '.[] | numbers' <<< '[1,"a"]'
jq -c 'tonumber' <<< '"1.50"'
jq -c '1 / 3'  <<< null
jq -c '[limit(3; repeat(1))]' <<< null
jq -c 'until(. > 100; . * 2)' <<< 1
jq -c '[recurse(if . < 3 then . + 1 else empty end)]' <<< 0
jq -c 'def f(x): x * 2; f(.)' <<< 3
jq -c '[.[] | if . then "t" elif . == null then "n" else "f" end]' <<< '[true,false,null]'
jq -c '.a += 1 | .b -= 1 | .c *= 2' <<< '{"a":1,"b":1,"c":2}'
jq -c '.. |= (if type == "string" then ascii_upcase else . end)' <<< '{"a":"x"}'
jq -c 'label $out | foreach .[] as $i (0; . + $i; if . > 2 then ., break $out else . end)' <<< '[1,2,3]'
jq -c 'input_line_number' <<< 1
jq -c '@text' <<< 1
jq -c 'ltrimstr(1)' <<< '"1a"'
jq -c 'sort' <<< '[3,"a",null,true,[1],{"a":1}]'
jq -c 'add' <<< '[]'
jq -c 'join("-")' <<< '[1,null,"a"]'
jq -c 'tostring' <<< '1.0'
jq -c '.' <<< '100000000000000000000'
jq -c '.' <<< '1.000'
jq -c 'keys_unsorted' <<< '{"b":1,"a":2}'
jq -c 'has(0)' <<< '[1]'
jq '.a.b.c' <<< '{"a":null}'
jq '.a.b' <<< '{"a":1}'; echo $?
jq -r '.[]' <<< '["a\nb"]'
jq -j '.[]' <<< '["a","b"]'; echo
jq --arg n 5 '$n|tonumber + 1' -n
jq --slurp -c . <<< '1 2'
jq -c --indent 1 . <<< '{"a":1}'
jq '.' <<< '{"a":1' 2>/dev/null; echo $?
jq -c 'ascii_downcase' <<< '"ABC"'
jq -c '@base64d' <<< '"aGk="'
jq -c 'getpath(["x"]) // "d"' <<< '{}'
jq -c 'map_values(. + 1)' <<< '{"a":1}'
jq -c 'to_entries[] | "\(.key):\(.value)"' <<< '{"a":1,"b":2}'
jq -c 'any(. > 2)' <<< '[1,3]'
jq -c 'isempty(empty)' <<< null
jq -c 'getpath(["a",0])' <<< '{"a":[9]}'
jq -c 'paths(type == "number")' <<< '{"a":1,"b":{"c":2}}'
jq -c 'leaf_paths' <<< '{"a":1}'
jq -c 'del(.. | nulls)' <<< '[1,null,2]'
jq -c 'tojson' <<< '"é"'
jq -c 'splits("\\s+")' <<< '"a  b"'
jq -c 'ascii_downcase | test("abc"; "i")' <<< '"ABC"'
jq -c 'significand' <<< 8 2>/dev/null || echo nosig
jq -c 'floor, ceil, round, sqrt' <<< 2.5
jq -c 'pow(2;10), log10' <<< 100
jq -c 'infinite, nan | isinfinite' <<< null
jq -c '[.[] | select(type == "object")]' <<< '[1,{}]'
jq -c 'todate' <<< 0
jq -c 'strftime("%Y")' <<< 0
jq -c '"2015-03-05T23:51:47Z" | fromdate'
jq -c 'splits(",")' <<< '"a,"'
#hard-find
find dir -name '*.txt' -newer dir/sub -o -name '*.md' -print | sort
find dir -type f -exec sh -c 'echo "f:$1"' _ {} \; | sort
find dir -type f -name '*.txt' | wc -l
find . -path ./dir -prune -o -name '*.txt' -print | sort
find dir -depth | head -1
find dir/ -maxdepth 1 | sort
find . -name 'x*' -type f
find dir -regex '.*/[xy]\..*' | sort
find dir -type f -size +0 | sort
find dir -name '*.txt' -printf '%s %p\n' | sort
find dir -type f -perm -u=r | wc -l
find dir -name sub -type d -exec ls {} \;
find dir -type f -print -quit | wc -l
find . -maxdepth 1 -type f -name '*.csv' -o -maxdepth 1 -name '*.json' | sort
find dir -mmin -60 -type f | wc -l
find dir -links 1 -type f | wc -l
find dir -wholename 'dir/sub/*'
find dir -type f -exec grep -l x {} + | sort
find dir -samefile dir/x.txt
find -name 'y.md'
find dir -printf '%d %y %P\n' | sort
find dir -type f -execdir echo {} \; | sort
